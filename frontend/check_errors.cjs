const puppeteer = require('puppeteer-core');
(async () => {
    try {
        const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new' });
        const page = await browser.newPage();
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
        await page.goto('http://localhost:5174', { waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 2000));
        await browser.close();
    } catch (e) { console.error('PUPPETEER EXCEPTION:', e.message); }
})();
