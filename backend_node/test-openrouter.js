require('dotenv').config();
const axios = require('axios');

async function test() {
    const token = process.env['gpt-oss-120b_token'];
    console.log("Token length:", token ? token.length : 0);
    try {
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: "openai/gpt-4o-mini",
            messages: [{ role: "user", content: "Say hello and return valid JSON { message: 'hello' }" }],
            temperature: 0.5,
            max_tokens: 300
        }, { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } });
        console.log("Result:", res.data.choices[0].message.content);
    } catch (e) {
        console.error("OpenRouter error:", e.response ? e.response.data : e.message);
    }
}
test();
