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
    downloadTimeout: 60000 // รอโหลดไฟล์นานสุด 60 วินาที
};

const downloadPath = path.resolve(__dirname, 'downloads');

// สร้างโฟลเดอร์ download ถ้ายังไม่มี
if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath);
}

// ฟังก์ชันส่งอีเมล (ปรับปรุงตามที่คุณต้องการ)
async function sendEmail(subject, message, attachmentPath = null) {
    if (!config.emailFrom || !config.emailPass) {
        console.log('Skipping email: No credentials provided.');
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: config.emailFrom, pass: config.emailPass }
    });

    // กำหนดรูปแบบไฟล์แนบ (ถ้ามี)
    const attachments = [];
    if (attachmentPath && fs.existsSync(attachmentPath)) {
        attachments.push({
            filename: path.basename(attachmentPath), // ดึงชื่อไฟล์จาก path เช่น Report.csv
            path: attachmentPath
        });
    }

    const mailOptions = {
        from: `"Thai Tracking DMS Reporter" <${config.emailFrom}>`, // ใส่ชื่อผู้ส่งตามต้องการ
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

(async () => {
    console.log('--- Started GPS Report Automation ---');
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--window-size=1920,1080'
        ]
    });

    const page = await browser.newPage();
    
    // ตั้งค่า Download Path ให้ Chrome
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
        
        // รอให้ Element ปรากฏ และหน่วงเวลาสักนิดให้ภาพโหลดชัดเจน
        await page.waitForSelector('#lwm'); 
        await new Promise(r => setTimeout(r, 2000)); // รอ 2 วินาทีกันภาพโหลดไม่ทัน
        
        const captchaElement = await page.$('#lwm');
        
        if (!captchaElement) throw new Error('Captcha element #lwm not found');

        // Screenshot เฉพาะรูป Captcha
        const captchaImage = await captchaElement.screenshot();
        
        // ใช้ AI อ่านตัวเลข
        const worker = await Tesseract.createWorker('eng');
        await worker.setParameters({ 
            tessedit_char_whitelist: '0123456789' // บังคับอ่านเฉพาะตัวเลข
        });
        const { data: { text } } = await worker.recognize(captchaImage);
        await worker.terminate();
        
        const captchaCode = text.trim().replace(/\s/g, '');
        console.log(`   READ CAPTCHA: "${captchaCode}"`);

        if (!captchaCode || captchaCode.length < 4) {
            throw new Error(`Captcha reading failed or invalid (Read: ${captchaCode})`);
        }

        // --- STEP 3: FILL LOGIN FORM ---
        console.log('3. Filling credentials...');
        // Selector ตามที่ระบุในภาพและ Code เก่า
        await page.type('#loginAccount', config.gpsUser);
        await page.type('#loginPassword', config.gpsPass);
        await page.type('#phraseLogin', captchaCode); // ช่องกรอก Code

        // --- STEP 4: SUBMIT LOGIN ---
        console.log('4. Logging in...');
        await Promise.all([
            page.click('#loginSubmit'),
            // รอหน้าเปลี่ยน หรือรออย่างน้อย 5 วินาที
            page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => console.log('Navigation wait timeout (might be AJAX login)'))
        ]);

        // ตรวจสอบ URL หรือ Error
        const currentUrl = page.url();
        console.log(`   Current URL: ${currentUrl}`);
        
        if (currentUrl.includes('login.html')) {
            // ลองเช็คว่ามี Alert error หรือไม่
            const errorText = await page.evaluate(() => {
                const el = document.querySelector('.layui-layer-content'); // เดา class error ของ layui ที่เว็บจีนชอบใช้
                return el ? el.innerText : null;
            });
            if (errorText) throw new Error(`Login Failed: ${errorText}`);
            throw new Error('Login Failed (Still on login page without detected error)');
        }
        
        console.log('   Login Successful!');

        // --- STEP 5: ไปหน้า Report ---
        console.log('5. Accessing Report...');
        
        // !!!!!!!!!!!! สำคัญ: ต้องใส่ Selector ของปุ่มรายงานที่นี่ !!!!!!!!!!!!
        // เนื่องจากผมไม่เห็นหน้าหลัง Login ผมใส่ Mock Code ไว้ให้คุณแก้
        // await page.click('#id_of_report_menu'); 
        // await new Promise(r => setTimeout(r, 3000)); // รอโหลด
        
        // จำลองว่าเราทำสำเร็จและได้ไฟล์มา
        // (ลบบรรทัดเขียนไฟล์นี้ทิ้ง เมื่อคุณใส่ Code กดโหลดไฟล์จริง)
        const mockFileName = `Report_${new Date().toISOString().slice(0,10)}.csv`;
        const mockFilePath = path.join(downloadPath, mockFileName);
        fs.writeFileSync(mockFilePath, `Date,Value\n${new Date().toISOString()},Test Report`);
        const downloadedFile = mockFilePath;
        // -------------------------------------------------------------

        // --- STEP 6: ส่งอีเมลพร้อมไฟล์แนบ ---
        console.log(`6. Sending Email with file: ${downloadedFile}`);
        
        await sendEmail(
            `GPS Report: ${new Date().toISOString().slice(0,10)}`, 
            'Please find the attached daily GPS report from Thai Tracking DMS.', 
            downloadedFile
        );

        // --- STEP 7: ลบไฟล์ทิ้ง (Cleanup) ---
        console.log('7. Cleaning up local files...');
        if (fs.existsSync(downloadedFile)) {
            fs.unlinkSync(downloadedFile);
            console.log('   File deleted successfully.');
        }

    } catch (error) {
        console.error('!!! PROCESS FAILED !!!', error);
        
        // Screenshot เพื่อ Debug (บันทึกไฟล์)
        const errorScreenshotPath = path.resolve(__dirname, 'error_debug.png');
        await page.screenshot({ path: errorScreenshotPath, fullPage: true });
        console.log(`   Saved screenshot to: ${errorScreenshotPath}`);
        
        // ส่งเมลแจ้งเตือน
        await sendEmail(`GPS Automation FAILED`, `Error details: ${error.message}`);

        // แจ้ง GitHub Actions ว่า Failed
        process.exit(1);
    } finally {
        await browser.close();
    }
})();