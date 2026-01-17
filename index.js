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

// ฟังก์ชันช่วยคลิก Element โดยใช้ XPath
async function clickByXPath(page, xpath, description = 'Element') {
    try {
        await page.waitForXPath(xpath, { timeout: 10000, visible: true });
        const elements = await page.$x(xpath);
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
            '--disable-popup-blocking', // ป้องกัน Popup ถูกบล็อก
            '--allow-running-insecure-content', // อนุญาตเนื้อหา HTTP
            '--ignore-certificate-errors',
            '--unsafely-treat-insecure-origin-as-secure=http://cctvwli.com:3001' // ระบุเว็บที่มีปัญหาให้มองว่าปลอดภัย
        ]
    });

    const page = await browser.newPage();
    
    // ตั้งค่า Download Path
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath,
    });

    page.setDefaultTimeout(60000);

    try {
        // --- STEP 1: LOGIN ---
        console.log('1. Navigating to login...');
        await page.goto('https://dvrai.net/808gps/login.html', { waitUntil: 'networkidle0' });

        // --- STEP 2: SOLVE CAPTCHA ---
        console.log('2. Solving CAPTCHA...');
        await page.waitForSelector('#lwm'); 
        await new Promise(r => setTimeout(r, 2000));
        
        const captchaElement = await page.$('#lwm');
        if (!captchaElement) throw new Error('Captcha element #lwm not found');

        const captchaImage = await captchaElement.screenshot();
        
        const worker = await Tesseract.createWorker('eng');
        await worker.setParameters({ tessedit_char_whitelist: '0123456789' });
        const { data: { text } } = await worker.recognize(captchaImage);
        await worker.terminate();
        
        const captchaCode = text.trim().replace(/\s/g, '');
        console.log(`   READ CAPTCHA: "${captchaCode}"`);
        if (!captchaCode || captchaCode.length < 4) throw new Error(`Captcha reading failed: ${captchaCode}`);

        // --- STEP 3: FILL LOGIN FORM ---
        console.log('3. Filling credentials...');
        await page.type('#loginAccount', config.gpsUser);
        await page.type('#loginPassword', config.gpsPass);
        await page.type('#phraseLogin', captchaCode);

        // --- STEP 4: SUBMIT LOGIN ---
        console.log('4. Logging in...');
        await Promise.all([
            page.click('#loginSubmit'),
            page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => console.log('Wait navigation timeout, continuing...'))
        ]);

        if (page.url().includes('login.html')) {
             throw new Error('Login Failed (Still on login page)');
        }
        console.log('   Login Successful!');

        // --- STEP 5: เข้าสู่หน้า Report Center (เปิด Tab ใหม่) ---
        console.log('5. Accessing Report Center...');
        
        // เตรียมดักจับ Popup ใหม่
        const newPagePromise = new Promise(resolve => {
            browser.once('targetcreated', async target => {
                if (target.type() === 'page') {
                    resolve(await target.page());
                }
            });
        });
        
        // --- แก้ไขจุดคลิกปุ่ม Report Center ---
        // ใช้ XPath ที่คุณระบุมาเป็นตัวหลัก
        const reportCenterXPath = `//*[@id="main-topPanel"]/div[6]/div[7]/i`;

        // รอให้ Element ปรากฏก่อนคลิก (เผื่อหน้าเว็บโหลดช้า)
        await page.waitForXPath(reportCenterXPath, { visible: true, timeout: 30000 });
        await clickByXPath(page, reportCenterXPath, 'Report Center Button (Laptop Icon)');
        
        // รอหน้าใหม่โหลด
        const reportPage = await newPagePromise;
        if (!reportPage) throw new Error("Report page did not open!");
        
        // รอให้หน้าโหลดเสร็จจริง
        await reportPage.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
        try {
            await reportPage.waitForXPath('//*[@id="root"]', { timeout: 10000 });
        } catch (e) {
            console.log('Warning: Root element taking too long, continuing anyway...');
        }
        
        await reportPage.setViewport({ width: 1920, height: 1080 });
        console.log(`   Switched to Report Page: ${reportPage.url()}`);

        // ตั้งค่า Download ให้หน้าใหม่
        const clientReport = await reportPage.target().createCDPSession();
        await clientReport.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath,
        });

        // --- STEP 6: ตั้งค่ารายงาน (DMS) ---
        console.log('6. Configuring Report Filters...');
        
        // 6.1 คลิกปุ่ม DMS Report
        await new Promise(r => setTimeout(r, 2000));
        await clickByXPath(reportPage, '//button[contains(.,"รายงาน DMS")] | //*[@data-testid="FaceIcon"]/..', 'DMS Report Button');

        // 6.2 เคลียร์รายการและเลือก Dropdown
        console.log('   Selecting Alerts...');
        await clickByXPath(reportPage, '//div[contains(@class, "css-xn5mga")]//tr[2]//td[2]//div/div', 'Alert Type Dropdown');
        
        await new Promise(r => setTimeout(r, 1000));

        const selectOption = async (optionText) => {
            const [option] = await reportPage.$x(`//div[contains(text(), '${optionText}')]`);
            if (option) {
                await option.click();
                console.log(`   Selected: ${optionText}`);
            } else {
                console.warn(`   Option not found: ${optionText}`);
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
        await reportPage.click('div.css-xn5mga tr:nth-of-type(3) td:nth-of-type(2) input', { clickCount: 3 });
        await reportPage.type('div.css-xn5mga tr:nth-of-type(3) td:nth-of-type(2) input', startDateTime);
        await reportPage.keyboard.press('Enter');

        const endInputXPath = '//div[contains(@class, "css-xn5mga")]//tr[3]//td[4]//input';
        await clickByXPath(reportPage, endInputXPath, 'End Date Input');
        await reportPage.click('div.css-xn5mga tr:nth-of-type(3) td:nth-of-type(4) input', { clickCount: 3 });
        await reportPage.type('div.css-xn5mga tr:nth-of-type(3) td:nth-of-type(4) input', endDateTime);
        await reportPage.keyboard.press('Enter');

        // 6.4 กดปุ่ม Search
        console.log('   Clicking Search...');
        await clickByXPath(reportPage, '//*[@data-testid="SearchIcon"]', 'Search Button');
        
        await new Promise(r => setTimeout(r, 5000));

        // 6.5 กดปุ่ม EXCEL
        console.log('   Clicking EXCEL...');
        await clickByXPath(reportPage, '//button[contains(text(), "EXCEL")] | //button[contains(@class, "MuiButton-containedSuccess")]', 'Excel Button');
        
        // 6.6 รอ Popup และกด Save
        console.log('   Waiting for Save/Download Dialog...');
        await reportPage.waitForXPath('//*[@data-testid="SaveOutlinedIcon"]', { visible: true, timeout: 30000 });
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
