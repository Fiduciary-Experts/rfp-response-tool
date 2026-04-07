const Anthropic = require('@anthropic-ai/sdk');

// Rate limiting
const requestLog = new Map();
const RATE_LIMIT = 20; // requests per minute
const RATE_WINDOW = 60000;

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  if (!requestLog.has(key)) requestLog.set(key, []);
  const timestamps = requestLog.get(key).filter(t => now - t < RATE_WINDOW);
  if (timestamps.length >= RATE_LIMIT) return false;
  timestamps.push(now);
  requestLog.set(key, timestamps);
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured. Set ANTHROPIC_API_KEY in Vercel environment variables.' });
  }

  try {
    const { system, messages, maxTokens } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 4096,
      system: system || '',
      messages: messages
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    return res.status(200).json({ text });
  } catch (err) {
    console.error('Claude API error:', err.message);
    return res.status(500).json({ error: 'Failed to get AI response. Please try again.' });
  }
};
