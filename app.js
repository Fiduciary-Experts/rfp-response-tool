// ===== RFP Response Tool — Fiduciary Experts =====

(function () {
    'use strict';

    // ===== State =====
    const state = {
        knowledgeBase: JSON.parse(localStorage.getItem('rfp_kb') || '[]'),
        pendingQA: [],
        currentRFP: null,       // { text, fileName }
        rfpAnalysis: null,      // { prospectProfile, questions }
        responses: [],          // [{ question, answer, confidence, source, index }]
        editingQAId: null
    };

    // ===== DOM Refs =====
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ===== Init =====
    document.addEventListener('DOMContentLoaded', () => {
        initTabs();
        initKBUpload();
        initRFPUpload();
        initModals();
        initKBExportImport();
        initGlobalFeedback();
        renderKBList();
        updateKBCount();
    });

    // ===== Tabs =====
    function initTabs() {
        $$('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                $$('.tab').forEach(t => t.classList.remove('active'));
                $$('.tab-content').forEach(tc => tc.classList.remove('active'));
                tab.classList.add('active');
                $(`#tab-${tab.dataset.tab}`).classList.add('active');
            });
        });
    }

    function switchToTab(tabName) {
        $$('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        $$('.tab-content').forEach(tc => {
            tc.classList.toggle('active', tc.id === `tab-${tabName}`);
        });
    }

    // ===== Toast =====
    function showToast(msg, type = '') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3500);
    }

    // ===== Document Parsing =====
    async function extractTextFromFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'docx') {
            const arrayBuffer = await file.arrayBuffer();
            const result = await mammoth.extractRawText({ arrayBuffer });
            return result.value;
        } else if (ext === 'pdf') {
            return await extractTextFromPDF(file);
        }
        throw new Error('Unsupported file type. Please upload .docx or .pdf');
    }

    async function extractTextFromPDF(file) {
        const arrayBuffer = await file.arrayBuffer();
        const pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;

        if (!pdfjsLib) {
            // Fallback: try dynamic import
            const pdf = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs');
            pdf.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
            const doc = await pdf.getDocument({ data: arrayBuffer }).promise;
            return await extractPDFPages(doc);
        }

        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
        const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        return await extractPDFPages(doc);
    }

    async function extractPDFPages(doc) {
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            pages.push(content.items.map(item => item.str).join(' '));
        }
        return pages.join('\n\n');
    }

    // ===== Claude API =====
    async function callClaude(system, userMessage, maxTokens = 4096) {
        const resp = await fetch('/api/claude', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system,
                messages: [{ role: 'user', content: userMessage }],
                maxTokens
            })
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(err.error || 'API request failed');
        }

        const data = await resp.json();
        return data.text;
    }

    // ===== Knowledge Base Upload =====
    function initKBUpload() {
        const zone = $('#kb-upload-zone');
        const input = $('#kb-file-input');

        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('dragover');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            handleKBFiles(e.dataTransfer.files);
        });
        input.addEventListener('change', () => {
            handleKBFiles(input.files);
            input.value = '';
        });

        $('#btn-approve-all').addEventListener('click', approveAllPending);
        $('#btn-reject-all').addEventListener('click', rejectAllPending);
        $('#btn-add-manual').addEventListener('click', () => openQAModal());
        $('#kb-search').addEventListener('input', renderKBList);
    }

    async function handleKBFiles(files) {
        if (!files.length) return;

        const processing = $('#kb-processing');
        const processingText = $('#kb-processing-text');
        processing.classList.remove('hidden');

        for (const file of files) {
            try {
                processingText.textContent = `Reading ${file.name}...`;
                const text = await extractTextFromFile(file);

                processingText.textContent = `Extracting Q&A pairs from ${file.name}...`;
                const qa = await extractQAPairs(text, file.name);
                state.pendingQA.push(...qa);
            } catch (err) {
                showToast(`Error processing ${file.name}: ${err.message}`, 'error');
            }
        }

        processing.classList.add('hidden');

        if (state.pendingQA.length > 0) {
            renderPendingQA();
        }
    }

    async function extractQAPairs(text, fileName) {
        const system = `You are an expert at analyzing RFP (Request for Proposal) documents for investment advisory services.
Extract all question-answer pairs from this document. Each pair should have:
- category: A short category (e.g., "Firm Background", "Fees & Compensation", "Investment Philosophy", "Compliance", "Technology", "Client Service", "Experience", "References")
- question: The question asked
- answer: The response/answer provided

Return ONLY a JSON array of objects with keys: category, question, answer.
If the document is an RFP response, extract the Q&A pairs as they appear.
If the document is a general company description, create Q&A pairs from the information (e.g., Q: "Describe your firm" A: [info from doc]).
Be thorough — extract every distinguishable question and answer.`;

        const result = await callClaude(system, `Document (${fileName}):\n\n${text.substring(0, 80000)}`, 8192);

        try {
            const jsonMatch = result.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const pairs = JSON.parse(jsonMatch[0]);
                return pairs.map(p => ({
                    id: generateId(),
                    category: p.category || 'General',
                    question: p.question,
                    answer: p.answer,
                    source: fileName,
                    dateAdded: new Date().toISOString()
                }));
            }
        } catch (e) {
            console.error('Parse error:', e);
        }
        showToast('Could not parse Q&A pairs from this document.', 'error');
        return [];
    }

    // ===== Pending Q&A =====
    function renderPendingQA() {
        const container = $('#kb-pending');
        const list = $('#kb-pending-list');
        container.classList.remove('hidden');

        list.innerHTML = state.pendingQA.map((qa, i) => `
            <div class="pending-qa-card" data-index="${i}">
                <span class="qa-category">${escapeHTML(qa.category)}</span>
                <div class="qa-question">${escapeHTML(qa.question)}</div>
                <div class="qa-answer collapsed">${escapeHTML(qa.answer)}</div>
                <div class="pending-actions">
                    <button class="btn btn-primary btn-sm" onclick="window._approveQA(${i})">
                        <i class="fas fa-check"></i> Approve
                    </button>
                    <button class="btn btn-outline btn-sm" onclick="window._editPendingQA(${i})">
                        <i class="fas fa-edit"></i> Edit
                    </button>
                    <button class="btn btn-ghost btn-sm" onclick="window._rejectQA(${i})">
                        <i class="fas fa-times"></i> Reject
                    </button>
                </div>
            </div>
        `).join('');
    }

    window._approveQA = function (index) {
        const qa = state.pendingQA.splice(index, 1)[0];
        state.knowledgeBase.push(qa);
        saveKB();
        renderPendingQA();
        renderKBList();
        updateKBCount();
        if (state.pendingQA.length === 0) $('#kb-pending').classList.add('hidden');
        showToast('Q&A pair added to knowledge base', 'success');
    };

    window._editPendingQA = function (index) {
        const qa = state.pendingQA[index];
        openQAModal(qa, index, true);
    };

    window._rejectQA = function (index) {
        state.pendingQA.splice(index, 1);
        renderPendingQA();
        if (state.pendingQA.length === 0) $('#kb-pending').classList.add('hidden');
    };

    function approveAllPending() {
        state.knowledgeBase.push(...state.pendingQA);
        state.pendingQA = [];
        saveKB();
        $('#kb-pending').classList.add('hidden');
        renderKBList();
        updateKBCount();
        showToast(`All Q&A pairs added to knowledge base`, 'success');
    }

    function rejectAllPending() {
        state.pendingQA = [];
        $('#kb-pending').classList.add('hidden');
    }

    // ===== Knowledge Base CRUD =====
    function saveKB() {
        localStorage.setItem('rfp_kb', JSON.stringify(state.knowledgeBase));
        updateKBCount();
    }

    function updateKBCount() {
        const count = state.knowledgeBase.length;
        $('#kb-count').textContent = count;
    }

    function renderKBList() {
        const searchTerm = ($('#kb-search')?.value || '').toLowerCase();
        const filtered = state.knowledgeBase.filter(qa =>
            qa.question.toLowerCase().includes(searchTerm) ||
            qa.answer.toLowerCase().includes(searchTerm) ||
            qa.category.toLowerCase().includes(searchTerm)
        );

        const list = $('#kb-list');
        if (filtered.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p>${searchTerm ? 'No matching Q&A pairs found.' : 'No Q&A pairs yet. Upload past RFP responses to get started.'}</p>
                </div>`;
            return;
        }

        // Group by category
        const grouped = {};
        filtered.forEach(qa => {
            const cat = qa.category || 'General';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(qa);
        });

        list.innerHTML = Object.entries(grouped).map(([category, items]) => `
            <div style="margin-bottom:0.5rem">
                <span class="qa-category" style="margin-bottom:0.5rem">${escapeHTML(category)} (${items.length})</span>
                ${items.map(qa => `
                    <div class="qa-card">
                        <div class="qa-card-header">
                            <div class="qa-question">${escapeHTML(qa.question)}</div>
                            <div class="qa-actions">
                                <button class="btn btn-ghost" onclick="window._editKBItem('${qa.id}')" title="Edit">
                                    <i class="fas fa-edit"></i>
                                </button>
                                <button class="btn btn-ghost" onclick="window._deleteKBItem('${qa.id}')" title="Delete">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </div>
                        <div class="qa-answer collapsed">${escapeHTML(qa.answer)}</div>
                        ${qa.source ? `<div style="font-size:0.75rem;color:var(--gray-500);margin-top:0.5rem">Source: ${escapeHTML(qa.source)}</div>` : ''}
                    </div>
                `).join('')}
            </div>
        `).join('');

        // Click to expand/collapse answers
        list.querySelectorAll('.qa-answer').forEach(el => {
            el.addEventListener('click', () => el.classList.toggle('collapsed'));
        });
    }

    window._editKBItem = function (id) {
        const qa = state.knowledgeBase.find(q => q.id === id);
        if (qa) openQAModal(qa, null, false);
    };

    window._deleteKBItem = function (id) {
        if (!confirm('Delete this Q&A pair?')) return;
        state.knowledgeBase = state.knowledgeBase.filter(q => q.id !== id);
        saveKB();
        renderKBList();
        showToast('Q&A pair deleted', 'success');
    };

    // ===== Q&A Modal =====
    function initModals() {
        $$('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.closest('.modal').classList.add('hidden');
            });
        });
        $$('.modal-backdrop').forEach(bd => {
            bd.addEventListener('click', () => {
                bd.closest('.modal').classList.add('hidden');
            });
        });

        $('#btn-modal-save').addEventListener('click', saveQAModal);
    }

    function openQAModal(qa = null, pendingIndex = null, isPending = false) {
        const modal = $('#modal-manual-qa');
        const title = $('#modal-qa-title');
        const catInput = $('#modal-qa-category');
        const qInput = $('#modal-qa-question');
        const aInput = $('#modal-qa-answer');

        if (qa) {
            title.textContent = 'Edit Q&A Pair';
            catInput.value = qa.category || '';
            qInput.value = qa.question || '';
            aInput.value = qa.answer || '';
            state.editingQAId = isPending ? { pending: pendingIndex } : qa.id;
        } else {
            title.textContent = 'Add Q&A Pair';
            catInput.value = '';
            qInput.value = '';
            aInput.value = '';
            state.editingQAId = null;
        }

        modal.classList.remove('hidden');
    }

    function saveQAModal() {
        const category = $('#modal-qa-category').value.trim() || 'General';
        const question = $('#modal-qa-question').value.trim();
        const answer = $('#modal-qa-answer').value.trim();

        if (!question || !answer) {
            showToast('Question and answer are required', 'error');
            return;
        }

        if (state.editingQAId && typeof state.editingQAId === 'object' && 'pending' in state.editingQAId) {
            // Editing a pending QA
            const idx = state.editingQAId.pending;
            state.pendingQA[idx] = { ...state.pendingQA[idx], category, question, answer };
            renderPendingQA();
        } else if (state.editingQAId) {
            // Editing existing KB item
            const qa = state.knowledgeBase.find(q => q.id === state.editingQAId);
            if (qa) {
                qa.category = category;
                qa.question = question;
                qa.answer = answer;
            }
            saveKB();
            renderKBList();
        } else {
            // New item
            state.knowledgeBase.push({
                id: generateId(),
                category,
                question,
                answer,
                source: 'Manual Entry',
                dateAdded: new Date().toISOString()
            });
            saveKB();
            renderKBList();
        }

        $('#modal-manual-qa').classList.add('hidden');
        showToast('Q&A pair saved', 'success');
    }

    // ===== KB Export / Import =====
    function initKBExportImport() {
        $('#btn-export-kb').addEventListener('click', () => {
            const data = JSON.stringify(state.knowledgeBase, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `rfp-knowledge-base-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Knowledge base exported', 'success');
        });

        $('#btn-import-kb').addEventListener('click', () => $('#import-kb-input').click());
        $('#import-kb-input').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!Array.isArray(data)) throw new Error('Invalid format');
                const count = data.length;
                state.knowledgeBase.push(...data.map(d => ({ ...d, id: d.id || generateId() })));
                saveKB();
                renderKBList();
                showToast(`Imported ${count} Q&A pairs`, 'success');
            } catch (err) {
                showToast('Invalid knowledge base file', 'error');
            }
            e.target.value = '';
        });
    }

    // ===== RFP Upload & Analysis =====
    function initRFPUpload() {
        const zone = $('#rfp-upload-zone');
        const input = $('#rfp-file-input');

        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('dragover');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleRFPFile(e.dataTransfer.files[0]);
        });
        input.addEventListener('change', () => {
            if (input.files.length) handleRFPFile(input.files[0]);
            input.value = '';
        });

        $('#btn-generate-responses').addEventListener('click', generateResponses);
    }

    async function handleRFPFile(file) {
        const processing = $('#rfp-processing');
        const progressFill = $('#rfp-progress');
        const progressLabel = $('#rfp-progress-label');
        const processingText = $('#rfp-processing-text');

        processing.classList.remove('hidden');
        $('#rfp-analysis').classList.add('hidden');

        try {
            // Step 1: Extract text
            processingText.textContent = `Reading ${file.name}...`;
            progressFill.style.width = '20%';
            progressLabel.textContent = 'Extracting text from document...';
            const text = await extractTextFromFile(file);
            state.currentRFP = { text, fileName: file.name };

            // Step 2: Analyze RFP
            processingText.textContent = 'Analyzing RFP requirements...';
            progressFill.style.width = '50%';
            progressLabel.textContent = 'AI is analyzing the prospect and identifying questions...';
            await analyzeRFP(text, file.name);

            progressFill.style.width = '100%';
            progressLabel.textContent = 'Analysis complete!';

            setTimeout(() => {
                processing.classList.add('hidden');
                $('#rfp-analysis').classList.remove('hidden');
            }, 500);

        } catch (err) {
            processing.classList.add('hidden');
            showToast(`Error: ${err.message}`, 'error');
        }
    }

    async function analyzeRFP(text, fileName) {
        const system = `You are an expert at analyzing RFP (Request for Proposal) documents for investment advisory firms.
Analyze this RFP and provide:

1. A prospect profile with these fields:
   - name: The organization/entity name issuing the RFP
   - planType: Type of retirement plan (401k, 457b, pension, etc.)
   - estimatedAssets: Approximate plan assets if mentioned
   - priorities: List of 3-5 things they seem to value most (e.g., "fee transparency", "fiduciary expertise", "technology")
   - tone: The overall tone/formality level expected
   - deadline: Submission deadline if mentioned
   - keyThemes: 2-3 sentence summary of what they're really looking for

2. A list of ALL questions/requirements they want addressed. For each:
   - number: Sequential number
   - question: The exact question or requirement
   - category: Category (Firm Background, Fees, Investment, Compliance, Service, Technology, etc.)
   - importance: "high", "medium", or "low" based on emphasis in the document

Return as JSON with structure:
{
  "profile": { name, planType, estimatedAssets, priorities, tone, deadline, keyThemes },
  "questions": [{ number, question, category, importance }]
}`;

        const result = await callClaude(system, `RFP Document (${fileName}):\n\n${text.substring(0, 80000)}`, 8192);

        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                state.rfpAnalysis = JSON.parse(jsonMatch[0]);
                renderRFPAnalysis();
                return;
            }
        } catch (e) {
            console.error('Parse error:', e);
        }
        throw new Error('Could not analyze RFP. Please try again.');
    }

    function renderRFPAnalysis() {
        const { profile, questions } = state.rfpAnalysis;

        // Render prospect profile
        const analysisContent = $('#rfp-analysis-content');
        const profileItems = [
            { label: 'Organization', value: profile.name || 'Not specified' },
            { label: 'Plan Type', value: profile.planType || 'Not specified' },
            { label: 'Est. Assets', value: profile.estimatedAssets || 'Not specified' },
            { label: 'Deadline', value: profile.deadline || 'Not specified' },
            { label: 'Tone', value: profile.tone || 'Professional' },
        ];

        analysisContent.innerHTML = `
            <div class="analysis-grid">
                ${profileItems.map(item => `
                    <div class="analysis-item">
                        <div class="analysis-item-label">${item.label}</div>
                        <div class="analysis-item-value">${escapeHTML(item.value)}</div>
                    </div>
                `).join('')}
            </div>
            ${profile.priorities ? `
                <div class="analysis-item" style="margin-top:1rem">
                    <div class="analysis-item-label">Key Priorities</div>
                    <div class="analysis-item-value">${Array.isArray(profile.priorities) ? profile.priorities.map(p => `<span style="display:inline-block;background:var(--accent-light);padding:2px 8px;border-radius:4px;margin:2px;font-size:0.85rem">${escapeHTML(p)}</span>`).join('') : escapeHTML(profile.priorities)}</div>
                </div>
            ` : ''}
            ${profile.keyThemes ? `
                <div style="margin-top:1rem">
                    <div class="analysis-item-label">Analysis Summary</div>
                    <div class="analysis-summary">${escapeHTML(profile.keyThemes)}</div>
                </div>
            ` : ''}
        `;

        // Render questions
        $('#rfp-question-count').textContent = questions.length;
        const qList = $('#rfp-questions-list');
        qList.innerHTML = questions.map(q => `
            <div class="question-preview">
                <span class="question-number">${q.number}</span>
                <div>
                    <div style="font-weight:500;font-size:0.88rem">${escapeHTML(q.question)}</div>
                    <div style="font-size:0.75rem;color:var(--gray-500);margin-top:2px">
                        ${escapeHTML(q.category)}
                        ${q.importance === 'high' ? ' <span style="color:var(--danger);font-weight:600">High Priority</span>' : ''}
                    </div>
                </div>
            </div>
        `).join('');
    }

    // ===== Response Generation =====
    async function generateResponses() {
        if (!state.rfpAnalysis) return;

        const { profile, questions } = state.rfpAnalysis;
        const processing = $('#rfp-processing');
        const progressFill = $('#rfp-progress');
        const progressLabel = $('#rfp-progress-label');
        const processingText = $('#rfp-processing-text');

        processing.classList.remove('hidden');
        $('#rfp-analysis').classList.add('hidden');
        processingText.textContent = 'Generating tailored responses...';

        state.responses = [];
        const totalQ = questions.length;

        // Build knowledge base context
        const kbContext = state.knowledgeBase.length > 0
            ? state.knowledgeBase.map(qa => `[${qa.category}] Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n---\n\n')
            : 'No past responses available.';

        // Process in batches of 5 to balance speed and quality
        const batchSize = 5;
        for (let i = 0; i < totalQ; i += batchSize) {
            const batch = questions.slice(i, i + batchSize);
            const progress = Math.round(((i) / totalQ) * 100);
            progressFill.style.width = `${progress}%`;
            progressLabel.textContent = `Generating response ${i + 1} of ${totalQ}...`;

            const system = `You are a senior investment advisor at Fiduciary Experts, a registered investment advisory firm specializing in retirement plan consulting. You are drafting responses for an RFP.

PROSPECT PROFILE:
- Organization: ${profile.name || 'Unknown'}
- Plan Type: ${profile.planType || 'Retirement plan'}
- Estimated Assets: ${profile.estimatedAssets || 'Not specified'}
- Their Priorities: ${Array.isArray(profile.priorities) ? profile.priorities.join(', ') : profile.priorities || 'General'}
- Expected Tone: ${profile.tone || 'Professional'}
- Key Themes: ${profile.keyThemes || 'Standard RFP'}

KNOWLEDGE BASE (past responses for reference):
${kbContext.substring(0, 40000)}

INSTRUCTIONS:
- Write professional, confident responses tailored to this specific prospect
- Reference their priorities and concerns where relevant
- Use the knowledge base answers as foundation but adapt to this prospect
- Be specific and detailed, not generic
- If the knowledge base has relevant info, use it. If not, write a strong general response
- For each question, provide a confidence rating: "high" (direct KB match), "medium" (partial match), "low" (no KB match, generated fresh)

Return a JSON array with objects: { "number": N, "answer": "response text", "confidence": "high|medium|low", "sourceRef": "brief note on KB match or 'Generated'" }`;

            const userMsg = `Generate responses for these RFP questions:\n\n${batch.map(q => `${q.number}. [${q.category}] ${q.question}`).join('\n\n')}`;

            try {
                const result = await callClaude(system, userMsg, 8192);
                const jsonMatch = result.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const responses = JSON.parse(jsonMatch[0]);
                    responses.forEach(r => {
                        const q = questions.find(qq => qq.number === r.number);
                        state.responses.push({
                            index: r.number,
                            question: q ? q.question : `Question ${r.number}`,
                            category: q ? q.category : 'General',
                            answer: r.answer,
                            confidence: r.confidence || 'medium',
                            source: r.sourceRef || 'Generated',
                            importance: q ? q.importance : 'medium'
                        });
                    });
                }
            } catch (err) {
                console.error('Batch error:', err);
                // Add placeholder for failed questions
                batch.forEach(q => {
                    state.responses.push({
                        index: q.number,
                        question: q.question,
                        category: q.category,
                        answer: '[Error generating response. Click Regenerate to try again.]',
                        confidence: 'low',
                        source: 'Error',
                        importance: q.importance
                    });
                });
            }
        }

        progressFill.style.width = '100%';
        progressLabel.textContent = 'All responses generated!';

        setTimeout(() => {
            processing.classList.add('hidden');
            renderResponses();
            switchToTab('review');
        }, 500);
    }

    function renderResponses() {
        const empty = $('#review-empty');
        const controls = $('#review-controls');

        if (state.responses.length === 0) {
            empty.classList.remove('hidden');
            controls.classList.add('hidden');
            return;
        }

        empty.classList.add('hidden');
        controls.classList.remove('hidden');

        // Update badge
        const badge = $('#response-count');
        badge.textContent = state.responses.length;
        badge.classList.remove('hidden');

        // Toolbar
        const profile = state.rfpAnalysis?.profile;
        $('#review-prospect-name').textContent = profile?.name || 'RFP Response';
        const highConf = state.responses.filter(r => r.confidence === 'high').length;
        const medConf = state.responses.filter(r => r.confidence === 'medium').length;
        const lowConf = state.responses.filter(r => r.confidence === 'low').length;
        $('#review-stats').innerHTML = `${state.responses.length} responses — <span style="color:var(--success)">${highConf} high</span> / <span style="color:var(--warning)">${medConf} med</span> / <span style="color:var(--danger)">${lowConf} low</span> confidence`;

        // Response cards
        const list = $('#review-list');
        list.innerHTML = state.responses
            .sort((a, b) => a.index - b.index)
            .map((r, i) => `
                <div class="response-card" data-index="${i}">
                    <div class="response-card-header">
                        <div class="response-question-wrap">
                            <div class="response-number">Question ${r.index} — ${escapeHTML(r.category)}</div>
                            <div class="response-question">${escapeHTML(r.question)}</div>
                        </div>
                        <span class="confidence-badge confidence-${r.confidence}">${r.confidence}</span>
                    </div>
                    <div class="response-body">
                        <div class="response-answer" id="answer-${i}">${escapeHTML(r.answer)}</div>
                        <div class="response-source">Source: ${escapeHTML(r.source)}</div>
                    </div>
                    <div class="response-footer">
                        <div class="response-feedback">
                            <input type="text" placeholder="Feedback (e.g., 'make shorter', 'add fee details')" id="feedback-${i}">
                            <button class="btn btn-primary btn-sm" onclick="window._regenerateOne(${i})">
                                <i class="fas fa-sync"></i> Regenerate
                            </button>
                        </div>
                        <button class="btn btn-ghost btn-sm" onclick="window._toggleEdit(${i})" title="Edit directly">
                            <i class="fas fa-pen"></i>
                        </button>
                    </div>
                </div>
            `).join('');
    }

    window._toggleEdit = function (index) {
        const el = $(`#answer-${index}`);
        const isEditing = el.contentEditable === 'true';
        if (isEditing) {
            el.contentEditable = 'false';
            state.responses[index].answer = el.textContent;
            showToast('Changes saved', 'success');
        } else {
            el.contentEditable = 'true';
            el.focus();
        }
    };

    window._regenerateOne = async function (index) {
        const r = state.responses[index];
        const feedback = $(`#feedback-${index}`)?.value || '';
        const profile = state.rfpAnalysis?.profile;

        const answerEl = $(`#answer-${index}`);
        const originalText = answerEl.textContent;
        answerEl.textContent = 'Regenerating...';

        const kbContext = state.knowledgeBase.length > 0
            ? state.knowledgeBase.slice(0, 30).map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n---\n\n')
            : 'No past responses available.';

        const system = `You are a senior investment advisor at Fiduciary Experts drafting an RFP response.
Prospect: ${profile?.name || 'Unknown'} | Plan: ${profile?.planType || 'Retirement'} | Priorities: ${Array.isArray(profile?.priorities) ? profile.priorities.join(', ') : ''}

Knowledge Base:\n${kbContext.substring(0, 20000)}

Write a professional, tailored response. Return ONLY the response text, no JSON.`;

        const userMsg = `Question: ${r.question}\n\nPrevious answer: ${originalText}\n\n${feedback ? `User feedback: ${feedback}\n\n` : ''}Please write an improved response.`;

        try {
            const result = await callClaude(system, userMsg, 2048);
            state.responses[index].answer = result;
            answerEl.textContent = result;
            if ($(`#feedback-${index}`)) $(`#feedback-${index}`).value = '';
            showToast('Response regenerated', 'success');
        } catch (err) {
            answerEl.textContent = originalText;
            showToast('Regeneration failed: ' + err.message, 'error');
        }
    };

    // ===== Global Feedback =====
    function initGlobalFeedback() {
        $('#btn-global-feedback').addEventListener('click', () => {
            $('#global-feedback-panel').classList.toggle('hidden');
        });
        $('#btn-cancel-feedback').addEventListener('click', () => {
            $('#global-feedback-panel').classList.add('hidden');
        });
        $('#btn-apply-feedback').addEventListener('click', applyGlobalFeedback);
        $('#btn-export-word').addEventListener('click', exportToWord);
    }

    async function applyGlobalFeedback() {
        const feedback = $('#global-feedback-text').value.trim();
        if (!feedback) {
            showToast('Please enter feedback', 'error');
            return;
        }

        const processing = $('#rfp-processing');
        const processingText = $('#rfp-processing-text');
        const progressFill = $('#rfp-progress');
        const progressLabel = $('#rfp-progress-label');

        $('#global-feedback-panel').classList.add('hidden');
        switchToTab('new-rfp');
        processing.classList.remove('hidden');
        processingText.textContent = 'Applying feedback and regenerating...';

        const profile = state.rfpAnalysis?.profile;
        const totalQ = state.responses.length;

        for (let i = 0; i < totalQ; i++) {
            const r = state.responses[i];
            progressFill.style.width = `${Math.round((i / totalQ) * 100)}%`;
            progressLabel.textContent = `Updating response ${i + 1} of ${totalQ}...`;

            try {
                const result = await callClaude(
                    `You are a senior investment advisor at Fiduciary Experts. Apply the user's feedback to improve this RFP response. Return ONLY the improved response text.`,
                    `Question: ${r.question}\n\nCurrent Answer: ${r.answer}\n\nGlobal Feedback to Apply: ${feedback}\n\nProspect: ${profile?.name || 'Unknown'}\n\nRewrite the answer incorporating the feedback.`,
                    2048
                );
                state.responses[i].answer = result;
            } catch (err) {
                console.error(`Failed to update response ${i}:`, err);
            }
        }

        processing.classList.add('hidden');
        renderResponses();
        switchToTab('review');
        showToast('All responses updated with feedback', 'success');
    }

    // ===== Word Export =====
    async function exportToWord() {
        const modal = $('#modal-export');
        const status = $('#export-status');
        modal.classList.remove('hidden');
        status.textContent = 'Generating Word document...';

        try {
            const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
                    BorderStyle, Table, TableRow, TableCell, WidthType, ShadingType,
                    Header, Footer, ImageRun, PageBreak } = window.docx;

            const profile = state.rfpAnalysis?.profile;
            const title = profile?.name ? `RFP Response — ${profile.name}` : 'RFP Response';

            // Try to load logo
            let logoData = null;
            try {
                const logoResp = await fetch('assets/fiduciary-experts-logo.png');
                if (logoResp.ok) logoData = await logoResp.arrayBuffer();
            } catch (e) { /* skip logo */ }

            // Build header children
            const headerChildren = [];
            if (logoData) {
                headerChildren.push(new Paragraph({
                    children: [
                        new ImageRun({ data: logoData, transformation: { width: 150, height: 50 }, type: 'png' })
                    ],
                    alignment: AlignmentType.LEFT,
                    spacing: { after: 100 }
                }));
            }

            // Title page
            const titlePageParagraphs = [
                new Paragraph({ spacing: { before: 2000 } }),
                new Paragraph({
                    children: [new TextRun({ text: title, bold: true, size: 56, color: '1a3a5c', font: 'Calibri' })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 200 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: 'Prepared by Fiduciary Experts', size: 28, color: '666666', font: 'Calibri' })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 100 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), size: 24, color: '999999', font: 'Calibri' })],
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 400 }
                }),
            ];

            if (profile) {
                const details = [
                    profile.planType ? `Plan Type: ${profile.planType}` : null,
                    profile.estimatedAssets ? `Estimated Assets: ${profile.estimatedAssets}` : null,
                    profile.deadline ? `Submission Deadline: ${profile.deadline}` : null,
                ].filter(Boolean);

                if (details.length > 0) {
                    titlePageParagraphs.push(
                        new Paragraph({
                            children: [new TextRun({ text: details.join('  |  '), size: 22, color: '888888', font: 'Calibri' })],
                            alignment: AlignmentType.CENTER,
                            spacing: { after: 200 }
                        })
                    );
                }
            }

            titlePageParagraphs.push(
                new Paragraph({ children: [new PageBreak()] })
            );

            // Q&A sections
            const qaSections = [];
            const sortedResponses = [...state.responses].sort((a, b) => a.index - b.index);

            // Group by category
            const grouped = {};
            sortedResponses.forEach(r => {
                const cat = r.category || 'General';
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push(r);
            });

            Object.entries(grouped).forEach(([category, items]) => {
                // Category heading
                qaSections.push(new Paragraph({
                    children: [new TextRun({ text: category, bold: true, size: 28, color: '1a3a5c', font: 'Calibri' })],
                    heading: HeadingLevel.HEADING_2,
                    spacing: { before: 400, after: 200 },
                    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: 'c8a951' } }
                }));

                items.forEach(r => {
                    // Question
                    qaSections.push(new Paragraph({
                        children: [
                            new TextRun({ text: `${r.index}. `, bold: true, size: 22, color: 'c8a951', font: 'Calibri' }),
                            new TextRun({ text: r.question, bold: true, size: 22, color: '1a3a5c', font: 'Calibri' })
                        ],
                        spacing: { before: 300, after: 100 }
                    }));

                    // Answer - split by newlines for proper paragraphs
                    const answerParagraphs = r.answer.split('\n').filter(line => line.trim());
                    answerParagraphs.forEach(para => {
                        qaSections.push(new Paragraph({
                            children: [new TextRun({ text: para, size: 22, color: '333333', font: 'Calibri' })],
                            spacing: { after: 100 },
                            indent: { left: 360 }
                        }));
                    });

                    // Spacer
                    qaSections.push(new Paragraph({ spacing: { after: 200 } }));
                });
            });

            const doc = new Document({
                styles: {
                    default: {
                        document: {
                            run: { font: 'Calibri', size: 22 }
                        }
                    }
                },
                sections: [{
                    headers: {
                        default: new Header({ children: headerChildren })
                    },
                    footers: {
                        default: new Footer({
                            children: [new Paragraph({
                                children: [new TextRun({ text: 'Fiduciary Experts — Confidential', size: 16, color: '999999', font: 'Calibri' })],
                                alignment: AlignmentType.CENTER
                            })]
                        })
                    },
                    children: [...titlePageParagraphs, ...qaSections]
                }]
            });

            const blob = await Packer.toBlob(doc);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `RFP Response - ${profile?.name || 'Draft'} - ${new Date().toISOString().split('T')[0]}.docx`;
            a.click();
            URL.revokeObjectURL(url);

            status.textContent = 'Document downloaded!';
            setTimeout(() => modal.classList.add('hidden'), 1000);
            showToast('Word document exported successfully', 'success');

        } catch (err) {
            console.error('Export error:', err);
            status.textContent = 'Export failed. See console for details.';
            setTimeout(() => modal.classList.add('hidden'), 2000);
            showToast('Export failed: ' + err.message, 'error');
        }
    }

    // ===== Utilities =====
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    function escapeHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

})();
