const puppeteer = require('puppeteer-core');
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: "new",
        defaultViewport: { width: 1440, height: 900 }
    });
    const page = await browser.newPage();
    try {
        await page.goto('http://localhost:5173', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 18000));

        // Screenshot 1: Hero + top
        await page.screenshot({ path: 'ss_hero.png' });
        console.log('Hero screenshot saved');

        // Screenshot 2: Scroll down to feed
        await page.evaluate(() => window.scrollBy(0, 700));
        await new Promise(r => setTimeout(r, 1000));
        await page.screenshot({ path: 'ss_feed.png' });
        console.log('Feed screenshot saved');

        // Screenshot 3: Scroll down more to trends
        await page.evaluate(() => window.scrollBy(0, 800));
        await new Promise(r => setTimeout(r, 1000));
        await page.screenshot({ path: 'ss_trends.png' });
        console.log('Trends screenshot saved');

        // Screenshot 4: Scroll to videos
        await page.evaluate(() => window.scrollBy(0, 800));
        await new Promise(r => setTimeout(r, 1000));
        await page.screenshot({ path: 'ss_videos.png' });
        console.log('Videos screenshot saved');
    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
})();
