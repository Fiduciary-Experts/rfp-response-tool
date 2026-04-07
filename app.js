// ===== RFP Response Tool — Fiduciary Experts =====
// No API key required — uses copy/paste workflow with Claude chat

(function () {
    'use strict';

    // ===== State =====
    const state = {
        knowledgeBase: JSON.parse(localStorage.getItem('rfp_kb') || '[]'),
        pendingQA: [],
        currentRFP: null,       // { text, fileName }
        rfpAnalysis: null,      // { profile, questions }
        responses: [],          // [{ question, answer, confidence, source, index }]
        editingQAId: null,
        currentPromptCallback: null  // function to call when user pastes response
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
        initPromptModal();
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
        const pdfjsLib = window.pdfjsLib;

        if (!pdfjsLib) {
            throw new Error('PDF reader failed to load. Please try a Word (.docx) file instead.');
        }

        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
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

    // ===== Prompt Modal (Copy Prompt → Paste Response) =====
    function initPromptModal() {
        $('#btn-copy-prompt').addEventListener('click', () => {
            const promptText = $('#prompt-output').value;
            navigator.clipboard.writeText(promptText).then(() => {
                $('#btn-copy-prompt').innerHTML = '<i class="fas fa-check"></i> Copied!';
                setTimeout(() => {
                    $('#btn-copy-prompt').innerHTML = '<i class="fas fa-copy"></i> Copy Prompt';
                }, 2000);
            });
        });

        $('#btn-submit-response').addEventListener('click', () => {
            const responseText = $('#paste-response').value.trim();
            if (!responseText) {
                showToast('Please paste Claude\'s response first', 'error');
                return;
            }
            if (state.currentPromptCallback) {
                state.currentPromptCallback(responseText);
                state.currentPromptCallback = null;
            }
            $('#modal-prompt').classList.add('hidden');
            $('#paste-response').value = '';
        });

        // Close handlers
        $$('#modal-prompt .modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                $('#modal-prompt').classList.add('hidden');
                state.currentPromptCallback = null;
            });
        });
        $('#modal-prompt .modal-backdrop').addEventListener('click', () => {
            $('#modal-prompt').classList.add('hidden');
            state.currentPromptCallback = null;
        });
    }

    function showPromptModal(title, stepInfo, prompt, onResponse) {
        $('#prompt-modal-title').textContent = title;
        $('#prompt-step-info').textContent = stepInfo;
        $('#prompt-output').value = prompt;
        $('#paste-response').value = '';
        state.currentPromptCallback = onResponse;
        $('#modal-prompt').classList.remove('hidden');
    }

    // ===== Knowledge Base Upload =====
    function initKBUpload() {
        const zone = $('#kb-upload-zone');
        const input = $('#kb-file-input');

        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            handleKBFiles(e.dataTransfer.files);
        });
        input.addEventListener('change', () => { handleKBFiles(input.files); input.value = ''; });

        $('#btn-approve-all').addEventListener('click', approveAllPending);
        $('#btn-reject-all').addEventListener('click', rejectAllPending);
        $('#btn-add-manual').addEventListener('click', () => openQAModal());
        $('#kb-search').addEventListener('input', renderKBList);
    }

    async function handleKBFiles(files) {
        if (!files.length) return;

        const processing = $('#kb-processing');
        const processingText = $('#kb-processing-text');

        for (const file of files) {
            try {
                processing.classList.remove('hidden');
                processingText.textContent = `Reading ${file.name}...`;
                const text = await extractTextFromFile(file);
                processing.classList.add('hidden');

                // Generate prompt for Claude
                const prompt = buildKBExtractionPrompt(text, file.name);

                showPromptModal(
                    'Extract Q&A Pairs',
                    `Step 1: Copy the prompt below and paste it into Claude. Step 2: Copy Claude's entire response and paste it back here.`,
                    prompt,
                    (responseText) => {
                        const pairs = parseJSONFromResponse(responseText, true);
                        if (pairs && Array.isArray(pairs) && pairs.length > 0) {
                            const qaPairs = pairs.map(p => ({
                                id: generateId(),
                                category: p.category || 'General',
                                question: p.question || '',
                                answer: p.answer || '',
                                source: file.name,
                                dateAdded: new Date().toISOString()
                            })).filter(p => p.question && p.answer);
                            state.pendingQA.push(...qaPairs);
                            renderPendingQA();
                            showToast(`Extracted ${qaPairs.length} Q&A pairs for review`, 'success');
                        } else {
                            showToast('Could not parse the response. Make sure you copied Claude\'s full response including the JSON array.', 'error');
                        }
                    }
                );
            } catch (err) {
                processing.classList.add('hidden');
                showToast(`Error reading ${file.name}: ${err.message}`, 'error');
            }
        }
    }

    function buildKBExtractionPrompt(text, fileName) {
        return `You are an expert at analyzing RFP (Request for Proposal) documents for investment advisory services.

Extract all question-answer pairs from this document. Each pair should have:
- category: A short category (e.g., "Firm Background", "Fees & Compensation", "Investment Philosophy", "Compliance", "Technology", "Client Service", "Experience", "References")
- question: The question asked
- answer: The response/answer provided

Return ONLY a JSON array of objects with keys: category, question, answer.
If the document is an RFP response, extract the Q&A pairs as they appear.
If the document is a general company description, create Q&A pairs from the information.
Be thorough — extract every distinguishable question and answer.

Document (${fileName}):

${text.substring(0, 60000)}`;
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

        // Click to expand
        list.querySelectorAll('.qa-answer').forEach(el => {
            el.addEventListener('click', () => el.classList.toggle('collapsed'));
        });
    }

    window._approveQA = function (index) {
        const qa = state.pendingQA.splice(index, 1)[0];
        state.knowledgeBase.push(qa);
        saveKB();
        renderPendingQA();
        renderKBList();
        if (state.pendingQA.length === 0) $('#kb-pending').classList.add('hidden');
        showToast('Q&A pair added to knowledge base', 'success');
    };

    window._editPendingQA = function (index) {
        openQAModal(state.pendingQA[index], index, true);
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
        showToast('All Q&A pairs added to knowledge base', 'success');
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
        $('#kb-count').textContent = state.knowledgeBase.length;
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
        // Only bind close handlers for non-prompt modals (prompt modal has its own handlers)
        $$('.modal-close').forEach(btn => {
            if (btn.closest('#modal-prompt')) return;
            btn.addEventListener('click', () => btn.closest('.modal').classList.add('hidden'));
        });
        $$('.modal-backdrop').forEach(bd => {
            if (bd.closest('#modal-prompt')) return;
            bd.addEventListener('click', () => bd.closest('.modal').classList.add('hidden'));
        });
        $('#btn-modal-save').addEventListener('click', saveQAModal);
    }

    function openQAModal(qa = null, pendingIndex = null, isPending = false) {
        const modal = $('#modal-manual-qa');
        $('#modal-qa-title').textContent = qa ? 'Edit Q&A Pair' : 'Add Q&A Pair';
        $('#modal-qa-category').value = qa?.category || '';
        $('#modal-qa-question').value = qa?.question || '';
        $('#modal-qa-answer').value = qa?.answer || '';
        state.editingQAId = isPending ? { pending: pendingIndex } : (qa?.id || null);
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
            const idx = state.editingQAId.pending;
            state.pendingQA[idx] = { ...state.pendingQA[idx], category, question, answer };
            renderPendingQA();
        } else if (state.editingQAId) {
            const qa = state.knowledgeBase.find(q => q.id === state.editingQAId);
            if (qa) { qa.category = category; qa.question = question; qa.answer = answer; }
            saveKB();
            renderKBList();
        } else {
            state.knowledgeBase.push({
                id: generateId(), category, question, answer,
                source: 'Manual Entry', dateAdded: new Date().toISOString()
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
            const blob = new Blob([JSON.stringify(state.knowledgeBase, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `rfp-knowledge-base-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            showToast('Knowledge base exported', 'success');
        });

        $('#btn-import-kb').addEventListener('click', () => $('#import-kb-input').click());
        $('#import-kb-input').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                if (!Array.isArray(data)) throw new Error();
                state.knowledgeBase.push(...data.map(d => ({ ...d, id: d.id || generateId() })));
                saveKB();
                renderKBList();
                showToast(`Imported ${data.length} Q&A pairs`, 'success');
            } catch { showToast('Invalid knowledge base file', 'error'); }
            e.target.value = '';
        });
    }

    // ===== RFP Upload & Analysis =====
    function initRFPUpload() {
        const zone = $('#rfp-upload-zone');
        const input = $('#rfp-file-input');

        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleRFPFile(e.dataTransfer.files[0]);
        });
        input.addEventListener('change', () => { if (input.files.length) handleRFPFile(input.files[0]); input.value = ''; });

        $('#btn-generate-responses').addEventListener('click', generateResponses);
    }

    async function handleRFPFile(file) {
        const processing = $('#rfp-processing');
        const processingText = $('#rfp-processing-text');

        processing.classList.remove('hidden');
        $('#rfp-analysis').classList.add('hidden');

        try {
            processingText.textContent = `Reading ${file.name}...`;
            const text = await extractTextFromFile(file);
            state.currentRFP = { text, fileName: file.name };
            processing.classList.add('hidden');

            // Generate analysis prompt
            const prompt = buildRFPAnalysisPrompt(text, file.name);

            showPromptModal(
                'Analyze RFP',
                'Step 1: Copy this prompt and paste it into Claude. Step 2: Copy Claude\'s entire JSON response and paste it back here.',
                prompt,
                (responseText) => {
                    const parsed = parseJSONFromResponse(responseText, false);
                    if (parsed && parsed.profile && parsed.questions) {
                        state.rfpAnalysis = parsed;
                        renderRFPAnalysis();
                        $('#rfp-analysis').classList.remove('hidden');
                        showToast('RFP analysis loaded successfully', 'success');
                    } else {
                        showToast('Could not parse the response. Make sure you copied Claude\'s full response.', 'error');
                    }
                }
            );
        } catch (err) {
            processing.classList.add('hidden');
            showToast(`Error: ${err.message}`, 'error');
        }
    }

    function buildRFPAnalysisPrompt(text, fileName) {
        return `You are an expert at analyzing RFP (Request for Proposal) documents for investment advisory firms.

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

Return ONLY valid JSON with this structure (no extra text before or after):
{
  "profile": { "name": "", "planType": "", "estimatedAssets": "", "priorities": [], "tone": "", "deadline": "", "keyThemes": "" },
  "questions": [{ "number": 1, "question": "", "category": "", "importance": "" }]
}

RFP Document (${fileName}):

${text.substring(0, 60000)}`;
    }

    function renderRFPAnalysis() {
        const { profile, questions } = state.rfpAnalysis;

        const profileItems = [
            { label: 'Organization', value: profile.name || 'Not specified' },
            { label: 'Plan Type', value: profile.planType || 'Not specified' },
            { label: 'Est. Assets', value: profile.estimatedAssets || 'Not specified' },
            { label: 'Deadline', value: profile.deadline || 'Not specified' },
            { label: 'Tone', value: profile.tone || 'Professional' },
        ];

        $('#rfp-analysis-content').innerHTML = `
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
            ` : ''}`;

        $('#rfp-question-count').textContent = questions.length;
        $('#rfp-questions-list').innerHTML = questions.map(q => `
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
    function generateResponses() {
        if (!state.rfpAnalysis) return;

        const { profile, questions } = state.rfpAnalysis;

        // Build knowledge base context
        const kbContext = state.knowledgeBase.length > 0
            ? state.knowledgeBase.map(qa => `[${qa.category}] Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n---\n\n')
            : 'No past responses available. Generate fresh professional responses.';

        const prompt = buildResponseGenerationPrompt(profile, questions, kbContext);

        showPromptModal(
            'Generate RFP Responses',
            'Step 1: Copy this prompt and paste it into Claude. Step 2: Copy Claude\'s entire JSON response and paste it back here. (For large RFPs, Claude may need to respond in parts — paste each part.)',
            prompt,
            (responseText) => {
                const parsed = parseJSONFromResponse(responseText, true);
                if (parsed && Array.isArray(parsed) && parsed.length > 0) {
                    state.responses = parsed.map((r, i) => {
                        const q = questions.find(qq => qq.number === r.number);
                        return {
                            index: r.number || (i + 1),
                            question: r.question || (q ? q.question : `Question ${i + 1}`),
                            category: r.category || (q ? q.category : 'General'),
                            answer: r.answer || '',
                            confidence: r.confidence || 'medium',
                            source: r.sourceRef || 'Generated',
                            importance: q ? q.importance : 'medium'
                        };
                    });
                    renderResponses();
                    switchToTab('review');
                    showToast(`${state.responses.length} responses loaded`, 'success');
                } else {
                    showToast('Could not parse responses. Make sure you copied Claude\'s full response.', 'error');
                }
            }
        );
    }

    function buildResponseGenerationPrompt(profile, questions, kbContext) {
        return `You are a senior investment advisor at Fiduciary Experts, a registered investment advisory firm specializing in retirement plan consulting. You are drafting responses for an RFP.

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
- For each question, rate confidence: "high" (direct KB match), "medium" (partial match), "low" (no KB match, generated fresh)

Return ONLY a valid JSON array (no extra text before or after):
[
  { "number": 1, "answer": "response text here", "confidence": "high", "sourceRef": "brief note on KB match or Generated" }
]

QUESTIONS TO ANSWER:
${questions.map(q => `${q.number}. [${q.category}${q.importance === 'high' ? ' - HIGH PRIORITY' : ''}] ${q.question}`).join('\n\n')}`;
    }

    // ===== Render Responses =====
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

        const badge = $('#response-count');
        badge.textContent = state.responses.length;
        badge.classList.remove('hidden');

        const profile = state.rfpAnalysis?.profile;
        $('#review-prospect-name').textContent = profile?.name || 'RFP Response';
        const highConf = state.responses.filter(r => r.confidence === 'high').length;
        const medConf = state.responses.filter(r => r.confidence === 'medium').length;
        const lowConf = state.responses.filter(r => r.confidence === 'low').length;
        $('#review-stats').innerHTML = `${state.responses.length} responses — <span style="color:var(--success)">${highConf} high</span> / <span style="color:var(--warning)">${medConf} med</span> / <span style="color:var(--danger)">${lowConf} low</span> confidence`;

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

    window._regenerateOne = function (index) {
        const r = state.responses[index];
        const feedback = $(`#feedback-${index}`)?.value || '';
        const profile = state.rfpAnalysis?.profile;

        const kbContext = state.knowledgeBase.slice(0, 20).map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n---\n\n');

        const prompt = `You are a senior investment advisor at Fiduciary Experts drafting an RFP response.
Prospect: ${profile?.name || 'Unknown'} | Plan: ${profile?.planType || 'Retirement'} | Priorities: ${Array.isArray(profile?.priorities) ? profile.priorities.join(', ') : ''}

Knowledge Base (past responses):
${kbContext.substring(0, 15000)}

Question: ${r.question}

Previous answer: ${r.answer}

${feedback ? `User feedback: ${feedback}\n` : ''}
Write an improved response. Return ONLY the response text, no JSON wrapping.`;

        showPromptModal(
            `Regenerate Q${r.index}`,
            'Copy this prompt into Claude, then paste the improved response back here.',
            prompt,
            (responseText) => {
                state.responses[index].answer = responseText.trim();
                renderResponses();
                showToast('Response updated', 'success');
            }
        );
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

    function applyGlobalFeedback() {
        const feedback = $('#global-feedback-text').value.trim();
        if (!feedback) { showToast('Please enter feedback', 'error'); return; }

        const profile = state.rfpAnalysis?.profile;
        const allResponses = state.responses.map(r => `Q${r.index}: ${r.question}\nA: ${r.answer}`).join('\n\n---\n\n');

        const prompt = `You are a senior investment advisor at Fiduciary Experts.

Apply this feedback across ALL of the following RFP responses: "${feedback}"

Prospect: ${profile?.name || 'Unknown'} | Plan: ${profile?.planType || 'Retirement'}

Current Responses:
${allResponses.substring(0, 50000)}

Rewrite ALL responses incorporating the feedback. Return ONLY a valid JSON array:
[{ "number": 1, "answer": "improved response text" }]`;

        showPromptModal(
            'Apply Global Feedback',
            'Copy this prompt into Claude, then paste the full JSON response back here.',
            prompt,
            (responseText) => {
                const parsed = parseJSONFromResponse(responseText, true);
                if (parsed && Array.isArray(parsed) && parsed.length > 0) {
                    parsed.forEach(u => {
                        const existing = state.responses.find(r => r.index === u.number);
                        if (existing) existing.answer = u.answer;
                    });
                    renderResponses();
                    showToast('All responses updated with feedback', 'success');
                } else {
                    showToast('Could not parse response. Try again.', 'error');
                }
            }
        );

        $('#global-feedback-panel').classList.add('hidden');
    }

    // ===== Word Export =====
    async function exportToWord() {
        const modal = $('#modal-export');
        const status = $('#export-status');
        modal.classList.remove('hidden');
        status.textContent = 'Generating Word document...';

        try {
            const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
                    BorderStyle, Header, Footer, ImageRun, PageBreak } = window.docx;

            const profile = state.rfpAnalysis?.profile;
            const title = profile?.name ? `RFP Response — ${profile.name}` : 'RFP Response';

            let logoData = null;
            try {
                const logoResp = await fetch('assets/fiduciary-experts-logo.png');
                if (logoResp.ok) logoData = await logoResp.arrayBuffer();
            } catch (e) { /* skip logo */ }

            const headerChildren = [];
            if (logoData) {
                headerChildren.push(new Paragraph({
                    children: [new ImageRun({ data: logoData, transformation: { width: 150, height: 50 }, type: 'png' })],
                    alignment: AlignmentType.LEFT,
                    spacing: { after: 100 }
                }));
            }

            // Title page
            const titlePageParagraphs = [
                new Paragraph({ spacing: { before: 2000 } }),
                new Paragraph({
                    children: [new TextRun({ text: title, bold: true, size: 56, color: '1a3a5c', font: 'Calibri' })],
                    alignment: AlignmentType.CENTER, spacing: { after: 200 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: 'Prepared by Fiduciary Experts', size: 28, color: '666666', font: 'Calibri' })],
                    alignment: AlignmentType.CENTER, spacing: { after: 100 }
                }),
                new Paragraph({
                    children: [new TextRun({ text: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), size: 24, color: '999999', font: 'Calibri' })],
                    alignment: AlignmentType.CENTER, spacing: { after: 400 }
                }),
            ];

            if (profile) {
                const details = [
                    profile.planType ? `Plan Type: ${profile.planType}` : null,
                    profile.estimatedAssets ? `Estimated Assets: ${profile.estimatedAssets}` : null,
                    profile.deadline ? `Submission Deadline: ${profile.deadline}` : null,
                ].filter(Boolean);

                if (details.length > 0) {
                    titlePageParagraphs.push(new Paragraph({
                        children: [new TextRun({ text: details.join('  |  '), size: 22, color: '888888', font: 'Calibri' })],
                        alignment: AlignmentType.CENTER, spacing: { after: 200 }
                    }));
                }
            }

            titlePageParagraphs.push(new Paragraph({ children: [new PageBreak()] }));

            // Q&A sections grouped by category
            const qaSections = [];
            const sortedResponses = [...state.responses].sort((a, b) => a.index - b.index);
            const grouped = {};
            sortedResponses.forEach(r => {
                const cat = r.category || 'General';
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push(r);
            });

            Object.entries(grouped).forEach(([category, items]) => {
                qaSections.push(new Paragraph({
                    children: [new TextRun({ text: category, bold: true, size: 28, color: '1a3a5c', font: 'Calibri' })],
                    heading: HeadingLevel.HEADING_2,
                    spacing: { before: 400, after: 200 },
                    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: 'c8a951' } }
                }));

                items.forEach(r => {
                    qaSections.push(new Paragraph({
                        children: [
                            new TextRun({ text: `${r.index}. `, bold: true, size: 22, color: 'c8a951', font: 'Calibri' }),
                            new TextRun({ text: r.question, bold: true, size: 22, color: '1a3a5c', font: 'Calibri' })
                        ],
                        spacing: { before: 300, after: 100 }
                    }));

                    r.answer.split('\n').filter(line => line.trim()).forEach(para => {
                        qaSections.push(new Paragraph({
                            children: [new TextRun({ text: para, size: 22, color: '333333', font: 'Calibri' })],
                            spacing: { after: 100 }, indent: { left: 360 }
                        }));
                    });

                    qaSections.push(new Paragraph({ spacing: { after: 200 } }));
                });
            });

            const doc = new Document({
                styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
                sections: [{
                    headers: { default: new Header({ children: headerChildren }) },
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
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `RFP Response - ${profile?.name || 'Draft'} - ${new Date().toISOString().split('T')[0]}.docx`;
            a.click();
            URL.revokeObjectURL(a.href);

            status.textContent = 'Document downloaded!';
            setTimeout(() => modal.classList.add('hidden'), 1000);
            showToast('Word document exported successfully', 'success');
        } catch (err) {
            console.error('Export error:', err);
            status.textContent = 'Export failed.';
            setTimeout(() => modal.classList.add('hidden'), 2000);
            showToast('Export failed: ' + err.message, 'error');
        }
    }

    // ===== Robust Response Parser =====
    // Handles JSON, markdown code blocks, AND plain text Q&A formats from Claude
    function parseJSONFromResponse(text, expectArray) {
        // Step 1: Strip markdown code blocks
        let cleaned = text.replace(/```(?:json|JSON)?\s*\n?/g, '').replace(/```/g, '').trim();

        // Step 2: Replace smart quotes
        cleaned = cleaned
            .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
            .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");

        // Step 3: Try parsing as JSON directly
        try {
            const parsed = JSON.parse(cleaned);
            if (expectArray ? Array.isArray(parsed) : typeof parsed === 'object') return parsed;
        } catch (e) { /* continue */ }

        // Step 4: Extract JSON from mixed text
        const pattern = expectArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
        const match = cleaned.match(pattern);
        if (match) {
            try { return JSON.parse(match[0]); } catch (e) {
                let fixed = match[0].replace(/,\s*([}\]])/g, '$1');
                try { return JSON.parse(fixed); } catch (e2) { /* continue */ }
            }
        }

        // Step 5: Parse plain-text Q&A format (bold markdown or plain)
        // Handles: **Q: ...** A: ... OR Q: ... A: ... OR **Question** Answer
        if (expectArray) {
            const qaFromText = parseTextQA(text);
            if (qaFromText.length > 0) return qaFromText;
        }

        return null;
    }

    // Parse plain-text Q&A pairs from various formats
    function parseTextQA(text) {
        const pairs = [];

        // Pattern 1: **Q: question** \n A: answer (markdown bold)
        const boldPattern = /\*\*Q:\s*(.*?)\*\*\s*\n\s*A:\s*([\s\S]*?)(?=\n\s*\*\*Q:|\n\s*---|\n\s*$)/gi;
        let match;
        while ((match = boldPattern.exec(text)) !== null) {
            const question = match[1].trim();
            const answer = match[2].trim();
            if (question && answer) {
                pairs.push({ category: categorizeQuestion(question), question, answer });
            }
        }
        if (pairs.length > 0) return pairs;

        // Pattern 2: Q: question \n A: answer (plain text, numbered or not)
        const plainPattern = /(?:^|\n)\s*(?:\d+[\.\)]\s*)?Q(?:uestion)?[:\.]?\s*(.*?)\n\s*A(?:nswer)?[:\.]?\s*([\s\S]*?)(?=\n\s*(?:\d+[\.\)]\s*)?Q(?:uestion)?[:\.]|\n\s*---|\s*$)/gi;
        while ((match = plainPattern.exec(text)) !== null) {
            const question = match[1].trim();
            const answer = match[2].trim();
            if (question && answer) {
                pairs.push({ category: categorizeQuestion(question), question, answer });
            }
        }
        if (pairs.length > 0) return pairs;

        // Pattern 3: Numbered questions with answers on next lines
        // "1. Question text \n Answer text \n\n 2. Question text..."
        const numberedPattern = /(?:^|\n)\s*(\d+)[\.\)]\s*(.*?)\n([\s\S]*?)(?=\n\s*\d+[\.\)]\s|\s*$)/g;
        while ((match = numberedPattern.exec(text)) !== null) {
            const question = match[2].trim();
            const answer = match[3].trim();
            if (question && answer && answer.length > 10) {
                pairs.push({ category: categorizeQuestion(question), question, answer });
            }
        }

        return pairs;
    }

    // Auto-categorize a question based on keywords
    function categorizeQuestion(question) {
        const q = question.toLowerCase();
        if (/fee|cost|pric|compens|billing|rate/.test(q)) return 'Fees & Compensation';
        if (/invest|fund|portfolio|asset|alloc|return|performance/.test(q)) return 'Investment';
        if (/compli|regulat|audit|sec |irs |legal|fiduciary/.test(q)) return 'Compliance';
        if (/technolog|software|system|platform|portal|online/.test(q)) return 'Technology';
        if (/service|support|communication|report|meeting/.test(q)) return 'Client Service';
        if (/experience|history|year|background|firm|staff|team|employee|founded/.test(q)) return 'Firm Background';
        if (/reference|client|testimonial/.test(q)) return 'References';
        if (/conflict|independent|disclos/.test(q)) return 'Compliance';
        if (/educat|seminar|workshop|training|onboard/.test(q)) return 'Education';
        if (/philosoph|approach|methodol|process|strategy/.test(q)) return 'Investment Philosophy';
        return 'General';
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
