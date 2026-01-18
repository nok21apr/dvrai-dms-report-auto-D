const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const config = {
    gpsUser: process.env.GPS_USER,
    gpsPass: process.env.GPS_PASSWORD,
    emailFrom: process.env.EMAIL_FROM,
    emailPass: process.env.EMAIL_PASSWORD,
    emailTo: process.env.EMAIL_TO,
    downloadTimeout: 120000 // เพิ่มเวลารอโหลดไฟล์เป็น 2 นาที
};

const downloadPath = path.resolve(__dirname, 'downloads');

// สร้างโฟลเดอร์ download ถ้ายังไม่มี
if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath);
}

// ฟังก์ชันรอจนกว่าไฟล์จะโหลดเสร็จ
async function waitForFileToDownload(dir, timeout) {
    return new Promise((resolve, reject) => {
        let timer;
        const checkInterval = 1000;
        let timePassed = 0;

        const checker = setInterval(() => {
            const files = fs.readdirSync(dir);
            const file = files.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp') && fs.statSync(path.join(dir, f)).isFile());

            if (file) {
                clearInterval(checker);
                clearTimeout(timer);
                resolve(path.join(dir, file));
            }

            timePassed += checkInterval;
            if (timePassed >= timeout) {
                clearInterval(checker);
                clearTimeout(timer);
                reject(new Error('Download timeout: No file found within time limit.'));
            }
        }, checkInterval);
    });
}

// ฟังก์ชันส่งอีเมล
async function sendEmail(subject, message, attachmentPath = null) {
    if (!config.emailFrom || !config.emailPass) {
        console.log('Skipping email: No credentials provided.');
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: config.emailFrom, pass: config.emailPass }
    });

    const attachments = [];
    if (attachmentPath && fs.existsSync(attachmentPath)) {
        attachments.push({
            filename: path.basename(attachmentPath), 
            path: attachmentPath
        });
    }

    const mailOptions = {
        from: `"Thai Tracking DMS Reporter" <${config.emailFrom}>`,
        to: config.emailTo,
        subject: subject,
        text: message,
        attachments: attachments
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully.');
    } catch (err) {
        console.error('Failed to send email:', err);
    }
}

// ฟังก์ชันช่วยคลิก Element โดยใช้ XPath (รับ timeout ได้ Default = 10วิ)
async function clickByXPath(page, xpath, description = 'Element', timeout = 10000) {
    try {
        // แปลง XPath ให้เป็น Selector แบบใหม่
        const selector = xpath.startsWith('xpath/') ? xpath : `xpath/${xpath}`;
        
        // ใช้ timeout ที่ส่งเข้ามา
        await page.waitForSelector(selector, { timeout: timeout, visible: true });
        const elements = await page.$$(selector);
        if (elements.length > 0) {
            await elements[0].click();
            console.log(`   Clicked: ${description}`);
        } else {
            throw new Error(`Element not found: ${description}`);
        }
    } catch (e) {
        throw new Error(`Failed to click ${description} (${xpath}): ${e.message}`);
    }
}

(async () => {
    console.log(`--- Started GPS Report Automation [${new Date().toLocaleString()}] ---`);
    const browser = await puppeteer.launch({
        headless: "new",
        ignoreHTTPSErrors: true, // ข้าม Error ใบรับรองความปลอดภัย
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--window-size=1920,1080',
            '--disable-popup-blocking',
            '--allow-running-insecure-content',
            '--ignore-certificate-errors',
            '--unsafely-treat-insecure-origin-as-secure=http://cctvwli.com:3001',
            '--disable-web-security', 
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
            '--disable-client-side-phishing-detection',
            '--no-first-run',
            '--no-default-browser-check',
            '--lang=th-TH' // *** บังคับภาษาไทย ***
        ]
    });

    const page = await browser.newPage();
    
    // ตั้งค่าภาษาเพิ่มเติม
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
    });
    
    // ตั้งค่า Download Path
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath,
    });

    page.setDefaultTimeout(60000);

    try {
        // --- LOGIN LOOP WITH RETRY ---
        let isLoggedIn = false;
        const maxRetries = 20; // จำนวนครั้งสูงสุดที่จะลอง Login

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`\n>>> Login Attempt ${attempt}/${maxRetries} <<<`);
                
                // 1. ไปหน้า Login
                await page.goto('https://dvrai.net/808gps/login.html', { waitUntil: 'networkidle0' });

                // 2. อ่าน CAPTCHA
                await page.waitForSelector('#lwm'); 
                await new Promise(r => setTimeout(r, 2000)); // รอภาพโหลด
                
                const captchaElement = await page.$('#lwm');
                if (!captchaElement) throw new Error('Captcha element #lwm not found');

                const captchaImage = await captchaElement.screenshot();
                
                const worker = await Tesseract.createWorker('eng');
                await worker.setParameters({ tessedit_char_whitelist: '0123456789' });
                const { data: { text } } = await worker.recognize(captchaImage);
                await worker.terminate();
                
                const captchaCode = text.trim().replace(/\s/g, '');
                console.log(`   READ CAPTCHA: "${captchaCode}"`);

                if (!captchaCode || captchaCode.length < 4) {
                    console.warn(`   !!! Invalid Captcha (Length < 4). Retrying...`);
                    continue; // ข้ามไปรอบถัดไปทันที
                }

                // 3. กรอกข้อมูล
                await page.type('#loginAccount', config.gpsUser);
                await page.type('#loginPassword', config.gpsPass);
                await page.type('#phraseLogin', captchaCode);

                // 4. กด Login
                console.log('   Clicking Login...');
                await Promise.all([
                    page.click('#loginSubmit'),
                    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }).catch(() => {})
                ]);

                // 5. ตรวจสอบผลลัพธ์
                const currentUrl = page.url();
                if (currentUrl.includes('login.html')) {
                    console.warn('   !!! Login Failed (Still on login page). Retrying...');
                    continue; // ข้ามไปรอบถัดไป
                } else {
                    console.log('   SUCCESS: Login Successful!');
                    isLoggedIn = true;
                    console.log('   Waiting 10 seconds for dashboard to fully load...');
                    await new Promise(r => setTimeout(r, 10000));
                    break; // ออกจาก Loop
                }
            } catch (err) {
                console.warn(`   Error during login attempt ${attempt}: ${err.message}`);
            }
        }

        if (!isLoggedIn) {
            throw new Error(`Failed to login after ${maxRetries} attempts.`);
        }

        // --- STEP 5: เข้าสู่หน้า Report Center (Loop Retry Mode) ---
        console.log('5. Accessing Report Center (Loop Retry)...');
        
        let reportPage = null;
        const initialPages = await browser.pages();
        const initialPageCount = initialPages.length;
        const startTime = Date.now();
        const stepTimeout = 60000;

        console.log(`   Initial pages: ${initialPageCount}. Starting click loop...`);

        while (Date.now() - startTime < stepTimeout) {
            const currentPages = await browser.pages();
            if (currentPages.length > initialPageCount) {
                reportPage = currentPages[currentPages.length - 1]; 
                console.log(`   >>> New tab detected! URL: ${reportPage.url()}`);
                
                // ตรวจสอบหน้าแดง (Warning Page)
                const pageTitle = await reportPage.title();
                console.log(`   Page Title: ${pageTitle}`);
                
                if (pageTitle.includes('Privacy error') || pageTitle.includes('Deceptive') || pageTitle.includes('Security')) {
                    console.log('   !!! Detected Security Warning Page. Attempting to bypass...');
                    try {
                        const advancedBtn = await reportPage.$('#details-button');
                        if (advancedBtn) {
                            await advancedBtn.click();
                            await new Promise(r => setTimeout(r, 1000));
                            const proceedLink = await reportPage.$('#proceed-link');
                            if (proceedLink) await proceedLink.click();
                        }
                    } catch (e) { console.log('   Bypass click failed (might not be needed with args)'); }
                }
                break;
            }

            console.log('   Attempting to trigger Report Center...');
            try {
                // พยายามคลิกปุ่มศูนย์รายงาน
                const jsResult = await page.evaluate(() => {
                    if (typeof showReportCenter === 'function') {
                        showReportCenter();
                        return 'Executed showReportCenter() directly';
                    } else {
                        const btn = document.querySelector('div[onclick*="showReportCenter"]') || 
                                    document.querySelector('#main-topPanel > div.header-nav > div:nth-child(7)');
                        if (btn) {
                            btn.click();
                            return 'Clicked element via JS';
                        }
                    }
                    return null;
                });
                if (jsResult) console.log(`   Success: ${jsResult}`);
            } catch (e) { console.log(`   Click attempt failed: ${e.message}`); }
            await new Promise(r => setTimeout(r, 5000));
        }

        if (!reportPage) {
            const finalPages = await browser.pages();
            if (finalPages.length > initialPageCount) {
                 reportPage = finalPages[finalPages.length - 1];
            } else {
                throw new Error("Failed to open Report Center after 60 seconds of retries.");
            }
        }
        
        try {
            await reportPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch(e) {}

        try {
            // ใช้ waitForSelector แบบ xpath แทน waitForXPath
            await reportPage.waitForSelector('xpath//*[@id="root"]', { timeout: 10000 });
        } catch (e) {
            console.log('Warning: Root element taking too long, continuing anyway...');
        }
        
        await reportPage.setViewport({ width: 1920, height: 1080 });
        console.log(`   Switched to Report Page: ${reportPage.url()}`);

        const clientReport = await reportPage.target().createCDPSession();
        await clientReport.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath,
        });

        // --- STEP 6: ตั้งค่ารายงาน (DMS) ---
        console.log('6. Configuring Report Filters...');
        
        // --- 6.1 Selecting DMS Report ---
        console.log('   6.1 Selecting DMS Report...');
        
        let dmsClicked = false;
        
        // Priority 1: Use specific ID and XPath for the SVG Icon's parent button
        const dmsSelectors = [
            '//*[local-name()="svg" and @data-testid="FaceIcon"]/..', 
            '//*[@id="root"]/div/div[2]/div[1]/div/button[2]', 
            '//button[contains(., "รายงาน DMS")]'
        ];

        for (const selector of dmsSelectors) {
            if (dmsClicked) break;
            try {
                console.log(`      Trying selector: ${selector}`);
                // แปลงเป็น xpath selector สำหรับ Puppeteer ใหม่
                const xpSelector = `xpath/${selector}`;
                await reportPage.waitForSelector(xpSelector, { visible: true, timeout: 5000 });
                const elements = await reportPage.$$(xpSelector);
                if (elements.length > 0) {
                    await elements[0].click();
                    console.log('      Clicked DMS Report button successfully!');
                    dmsClicked = true;
                }
            } catch (e) {
                console.log(`      Selector failed: ${selector}`);
            }
        }

        if (!dmsClicked) {
            // Fallback: JS Click
             console.warn('   Click selectors failed. Trying JS click...');
             try {
                const jsClicked = await reportPage.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const dmsBtn = buttons.find(b => b.textContent.includes('รายงาน DMS'));
                    if (dmsBtn) {
                        dmsBtn.click();
                        return true;
                    }
                    const svg = document.querySelector('svg[data-testid="FaceIcon"]');
                    if (svg && svg.parentElement) {
                        svg.parentElement.click();
                        return true;
                    }
                    return false;
                });
                if (jsClicked) {
                    console.log('      Clicked DMS Report button via JS!');
                    dmsClicked = true;
                }
             } catch (e) {
                console.error(`      JS Click failed: ${e.message}`);
             }
        }
        
        if (!dmsClicked) {
            throw new Error('Could not select DMS Report button via any method.');
        }

        // 6.2 เคลียร์รายการและเลือก Dropdown
        console.log('   Selecting Alerts...');
        await new Promise(r => setTimeout(r, 2000)); 
        await clickByXPath(reportPage, '//div[contains(@class, "css-xn5mga")]//tr[2]//td[2]//div/div', 'Alert Type Dropdown');
        
        await new Promise(r => setTimeout(r, 1000));

        const selectOption = async (optionText) => {
            // ใช้ xpath selector แทน $x
            const selector = `xpath///div[contains(text(), '${optionText}')]`;
            const elements = await reportPage.$$(selector);
            if (elements.length > 0) {
                await elements[0].click();
                console.log(`   Selected: ${optionText}`);
            } else {
                console.warn(`   Option not found: ${optionText} (Page might be in English?)`);
                
                // Fallback for English text if needed
                if (optionText === 'แจ้งเตือนการหาวนอน') {
                     const engSelector = `xpath///div[contains(text(), 'Yawning')]`; // เดาภาษาอังกฤษ
                     const engElements = await reportPage.$$(engSelector);
                     if(engElements.length > 0) { await engElements[0].click(); console.log('   Selected (EN): Yawning'); }
                }
            }
        };

        await selectOption('แจ้งเตือนการหาวนอน');
        await new Promise(r => setTimeout(r, 500));
        await selectOption('แจ้งเตือนการหลับตา');
        
        await reportPage.keyboard.press('Escape');

        // 6.3 ตั้งค่าเวลา
        const today = new Date().toISOString().slice(0, 10);
        const startDateTime = `${today} 06:00:00`;
        const endDateTime = `${today} 18:00:00`;
        console.log(`   Setting Time: ${startDateTime} to ${endDateTime}`);

        const startInputXPath = '//div[contains(@class, "css-xn5mga")]//tr[3]//td[2]//input';
        await clickByXPath(reportPage, startInputXPath, 'Start Date Input');
        
        // ใช้ CSS Selector สำหรับการพิมพ์ค่า (ง่ายกว่า)
        await reportPage.keyboard.down('Control');
        await reportPage.keyboard.press('A');
        await reportPage.keyboard.up('Control');
        await reportPage.keyboard.press('Backspace');
        await reportPage.keyboard.type(startDateTime);
        await reportPage.keyboard.press('Enter');

        const endInputXPath = '//div[contains(@class, "css-xn5mga")]//tr[3]//td[4]//input';
        await clickByXPath(reportPage, endInputXPath, 'End Date Input');
        
        await reportPage.keyboard.down('Control');
        await reportPage.keyboard.press('A');
        await reportPage.keyboard.up('Control');
        await reportPage.keyboard.press('Backspace');
        await reportPage.keyboard.type(endDateTime);
        await reportPage.keyboard.press('Enter');

        // 6.4 กดปุ่ม Search (แก้ไข: ใช้ Selector ใหม่ + เพิ่ม Timeout 60 วินาที)
        console.log('   Clicking Search...');
        // รอสักพักให้ UI นิ่งก่อนกด
        await new Promise(r => setTimeout(r, 2000));
        
        // Selector ที่คุณให้มา:
        // XPath: //*[@id="root"]/div/div[2]/div[3]/div/div[2]/table/tbody/tr[4]/td[2]/div/button[1]
        // Full XPath: /html/body/div[1]/div/div[2]/div[3]/div/div[2]/table/tbody/tr[4]/td[2]/div/button[1]
        
        const searchButtonXPath = `
            //*[@id="root"]/div/div[2]/div[3]/div/div[2]/table/tbody/tr[4]/td[2]/div/button[1] |
            //*[@data-testid="SearchIcon"]
        `;
        
        // เพิ่ม Timeout เป็น 60 วินาที สำหรับการหากดปุ่ม Search (ตามที่คุณแนะนำ)
        await clickByXPath(reportPage, searchButtonXPath, 'Search Button', 60000);
        
        // --- รอรายงานโหลด 120 วินาที (Hard Wait) ตามที่คุณแนะนำ ---
        console.log('   Waiting 120 seconds for report generation...');
        await new Promise(r => setTimeout(r, 120000));

        // 6.5 กดปุ่ม EXCEL
        console.log('   Clicking EXCEL...');
        // เพิ่ม timeout ให้ปุ่ม Excel เผื่อไว้ด้วย
        await clickByXPath(reportPage, '//button[contains(text(), "EXCEL")] | //button[contains(@class, "MuiButton-containedSuccess")]', 'Excel Button', 60000);
        
        // 6.6 รอ Popup และกด Save
        console.log('   Waiting for Save/Download Dialog...');
        // ใช้ waitForSelector xpath
        await reportPage.waitForSelector('xpath//*[@data-testid="SaveOutlinedIcon"]', { visible: true, timeout: 60000 });
        await new Promise(r => setTimeout(r, 1000));
        await clickByXPath(reportPage, '//*[@data-testid="SaveOutlinedIcon"]', 'Save Icon (Download)');

        // --- STEP 7: รอไฟล์ดาวน์โหลด ---
        console.log('7. Waiting for file download...');
        const downloadedFile = await waitForFileToDownload(downloadPath, config.downloadTimeout);
        console.log(`   File downloaded: ${downloadedFile}`);

        // --- STEP 8: ส่งอีเมลพร้อมไฟล์แนบ ---
        console.log(`8. Sending Email...`);
        
        await sendEmail(
            `GPS Report: ${today}`, 
            `Please find the attached daily GPS report (06:00-18:00) for ${today}.`, 
            downloadedFile
        );

        // --- STEP 9: ลบไฟล์ทิ้ง (Cleanup) ---
        console.log('9. Cleaning up...');
        if (fs.existsSync(downloadedFile)) {
            fs.unlinkSync(downloadedFile);
            console.log('   File deleted.');
        }

    } catch (error) {
        console.error('!!! PROCESS FAILED !!!', error);
        
        // Screenshot หน้าจอที่มีปัญหา
        const pages = await browser.pages();
        const activePage = pages[pages.length - 1]; 
        
        const errorScreenshotPath = path.resolve(__dirname, 'error_debug.png');
        await activePage.screenshot({ path: errorScreenshotPath, fullPage: true });
        console.log(`   Saved screenshot to: ${errorScreenshotPath}`);
        
        await sendEmail(`GPS Automation FAILED`, `Error details: ${error.message}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
