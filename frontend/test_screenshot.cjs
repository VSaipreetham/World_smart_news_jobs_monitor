const puppeteer = require('puppeteer-core');

(async () => {
    // Use edge since Chrome might not be in default puppeteer path if we didn't download it
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: "new",
        defaultViewport: { width: 1280, height: 800 }
    });
    const page = await browser.newPage();

    try {
        await page.goto('http://localhost:5174', { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 8000));
        // Click on a feed item to open the modal
        const firstFeedItem = await page.$('.feed-item.job');
        if (firstFeedItem) {
            await firstFeedItem.click();
            await new Promise(resolve => setTimeout(resolve, 1000)); // wait for modal animation
        }
        await page.screenshot({ path: 'screenshot.png' });
        console.log('Screenshot saved to screenshot.png');
    } catch (e) {
        console.error('Error:', e);
    } finally {
        await browser.close();
    }
})();
