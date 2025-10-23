import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import axios from "axios";

dotenv.config();

console.log("Environment variables:", {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: !!process.env.SMTP_PASS,
  EMAIL_FROM: process.env.EMAIL_FROM,
  PROJECT_ID: process.env.PROJECT_ID,
  CLIENT_EMAIL: process.env.CLIENT_EMAIL,
  PRIVATE_KEY: !!process.env.PRIVATE_KEY,
  PAYCHANGU_SECRET_KEY: !!process.env.PAYCHANGU_SECRET_KEY,
  PORT: process.env.PORT,
});

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: ['https://ibratechinnovations.com', 'https://app.ibratechinnovations.com'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json());

// Initialize Nodemailer
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465", // true for 465 (SSL), false for 587 (TLS)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

// Nodemailer email sending with retry logic
const sendMailWithRetry = async (mailOptions, maxRetries = 3, retryDelay = 2000) => {
  const transporter = createTransporter();
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully: ${info.messageId}`);
      return info;
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, {
        message: error.message,
        code: error.code,
        response: error.response ? {
          code: error.responseCode,
          command: error.command,
        } : null,
        stack: error.stack,
      });
      if (attempt < maxRetries) {
        console.log(`Retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt - 1)));
      } else {
        throw new Error(`All ${maxRetries} retry attempts failed: ${error.message}`);
      }
    }
  }
};

// Verify Nodemailer configuration on startup
async function verifyNodemailer() {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log("✅ Nodemailer SMTP configuration verified");
  } catch (error) {
    console.error("❌ Nodemailer SMTP verification failed:", {
      message: error.message,
      code: error.code,
      response: error.response ? {
        code: error.responseCode,
        command: error.command,
      } : null,
    });
  }
}

let adminApp = null;
let firestore = null;

async function initializeFirebase() {
  try {
    const serviceAccount = {
      projectId: process.env.PROJECT_ID,
      clientEmail: process.env.CLIENT_EMAIL,
      privateKey: process.env.PRIVATE_KEY?.replace(/\\n/g, "\n"),
    };
    if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
      throw new Error("Missing Firebase service account credentials");
    }
    adminApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firestore = admin.firestore();
    console.log("✅ Firebase Admin SDK initialized successfully with Firestore");
    const testUser = await admin.auth().listUsers(1);
    console.log("✅ Admin SDK test passed: Found", testUser.users.length, "users");
  } catch (error) {
    console.error("❌ Firebase Admin SDK initialization failed:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    throw error;
  }
}

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    console.error("No token provided", { path: req.path, method: req.method });
    return res.status(401).json({ message: "No token provided" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    console.log("Token verified:", { uid: decoded.uid, email: decoded.email });
    req.user = decoded;
    next();
  } catch (error) {
    console.error("Token verification error:", {
      message: error.message,
      code: error.code,
      path: req.path,
      method: req.method,
      stack: error.stack,
    });
    res.status(401).json({ message: "Invalid token", error: error.message });
  }
};

app.get("/", (req, res) => {
  res.status(200).json({ message: "✅ Backend is running at https://server-dmx8.onrender.com!" });
});

app.get("/test-email", async (req, res) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || '"InventoryMW" <inventorymw@gmail.com>',
    to: process.env.TEST_EMAIL || "test@example.com",
    subject: "Test Email from InventoryMW",
    text: "This is a test email to verify Nodemailer configuration.",
  };
  try {
    await sendMailWithRetry(mailOptions);
    console.log("✅ Test email sent to:", process.env.TEST_EMAIL);
    res.status(200).json({ message: "✅ Test email sent successfully" });
  } catch (error) {
    console.error("❌ Test email error:", {
      message: error.message,
      code: error.code,
      response: error.response ? {
        code: error.responseCode,
        command: error.command,
      } : null,
      stack: error.stack,
    });
    res.status(500).json({ message: "❌ Failed to send test email", error: error.message });
  }
});

app.get("/test-firestore", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  try {
    const userDoc = await firestore.doc(`users/${userId}`).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    console.log("Firestore test:", { userId, userData });
    res.status(200).json({
      message: "Firestore access successful",
      userData: userData || "No user data found",
    });
  } catch (error) {
    console.error("Firestore test error:", {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    res.status(500).json({ message: "Failed to access Firestore", error: error.message });
  }
});

app.post("/debug-email", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const userEmail = req.user.email;
  try {
    const userDoc = await firestore.doc(`users/${userId}`).get();
    if (!userDoc.exists) {
      console.log("User document not found, creating default", { userId });
      await firestore.doc(`users/${userId}`).set({
        email: userEmail,
        settings: { emailNotifications: true, inventoryAlerts: true },
      }, { merge: true });
    }
    const mailOptions = {
      from: process.env.EMAIL_FROM || '"InventoryMW" <inventorymw@gmail.com>',
      to: userEmail,
      subject: "Debug Email from InventoryMW",
      html: `
        <h2>Debug Email</h2>
        <p>This is a test email to verify Nodemailer configuration.</p>
        <p>User ID: ${userId}</p>
        <p>Email: ${userEmail}</p>
        <p>Thank you for using InventoryMW.</p>
      `,
    };
    await sendMailWithRetry(mailOptions);
    console.log("✅ Debug email sent to:", userEmail);
    res.status(200).json({ message: "✅ Debug email sent successfully" });
  } catch (error) {
    console.error("❌ Debug email error:", {
      message: error.message,
      code: error.code,
      response: error.response ? {
        code: error.responseCode,
        command: error.command,
      } : null,
      stack: error.stack,
    });
    res.status(500).json({ message: "Failed to send debug email", error: error.message });
  }
});

app.post("/api/send-email-notification", verifyToken, async (req, res) => {
  const { userId, saleData, cartItems, totalAmount } = req.body;
  if (!userId || !saleData || !cartItems || !totalAmount) {
    console.error("Missing required fields", {
      body: req.body,
      userId: req.user.uid,
    });
    return res.status(400).json({
      message: "Missing required fields",
      missing: {
        userId: !userId,
        saleData: !saleData,
        cartItems: !cartItems,
        totalAmount: !totalAmount,
      },
    });
  }
  if (!saleData.Sale_id || !saleData.Saledate) {
    console.error("Invalid saleData", { saleData });
    return res.status(400).json({ message: "saleData must include Sale_id and Saledate" });
  }
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    console.error("Invalid cartItems", { cartItems });
    return res.status(400).json({ message: "cartItems must be a non-empty array" });
  }
  for (const item of cartItems) {
    if (!item.item_id || !item.item_name || !item.price || !item.quantity || !item.total) {
      console.error("Invalid cart item", { item });
      return res.status(400).json({ message: "Each cart item must include item_id, item_name, price, quantity, and total" });
    }
  }
  if (typeof totalAmount !== "number" || totalAmount <= 0) {
    console.error("Invalid totalAmount", { totalAmount });
    return res.status(400).json({ message: "totalAmount must be a positive number" });
  }
  try {
    // Check if the requesting user is an admin
    const requesterDoc = await firestore.doc(`users/${req.user.uid}`).get();
    const requesterData = requesterDoc.exists ? requesterDoc.data() : {};
    const isAdmin = requesterData.role === 'admin';

    // Restrict non-admin users to their own userId
    if (!isAdmin && userId !== req.user.uid) {
      console.error("Non-admin user attempted to send notification for another user", {
        requestUserId: userId,
        authUserId: req.user.uid,
      });
      return res.status(403).json({ message: "Non-admin users can only send notifications for themselves" });
    }

    // Fetch the target user's document
    const userDoc = await firestore.doc(`users/${userId}`).get();
    if (!userDoc.exists) {
      console.error("Target user not found", { userId });
      return res.status(404).json({ message: "Target user not found in Firestore" });
    }
    const userData = userDoc.data();
    const userEmail = userData.email;
    if (!userEmail) {
      console.error("Target user has no email", { userId });
      return res.status(400).json({ message: "Target user has no registered email" });
    }

    // Check email notification settings
    if (!userData?.settings?.emailNotifications) {
      console.log("Email notifications disabled for user", { userId, settings: userData?.settings });
      return res.status(200).json({ message: "Email notifications are disabled for this user" });
    }

    const emailSubject = `New Sale Completed - ${saleData.Saledate}`;
    let emailBody = `
      <h2>Sale Notification</h2>
      <p>Dear User,</p>
      <p>A new sale has been completed in your inventory system.</p>
      <p><strong>Sale ID:</strong> ${saleData.Sale_id}</p>
      <p><strong>Date:</strong> ${saleData.Saledate}</p>
      <p><strong>Total Amount:</strong> MK ${Number(totalAmount).toLocaleString()}</p>
      <p><strong>Items Sold:</strong></p>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
        <thead>
          <tr style="background-color: #f2f2f2;">
            <th>Item Name</th>
            <th>Quantity</th>
            <th>Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
    `;
    cartItems.forEach((item) => {
      emailBody += `
        <tr>
          <td>${item.item_name}</td>
          <td>${item.quantity}</td>
          <td>MK ${Number(item.price).toLocaleString()}</td>
          <td>MK ${Number(item.total).toLocaleString()}</td>
        </tr>
      `;
    });
    emailBody += `
        </tbody>
      </table>
      <p>Thank you for using InventoryMW.</p>
      <p><em>This is an automated notification. Please do not reply.</em></p>
    `;
    const mailOptions = {
      from: process.env.EMAIL_FROM || '"InventoryMW" <inventorymw@gmail.com>',
      to: userEmail,
      subject: emailSubject,
      html: emailBody,
    };
    await sendMailWithRetry(mailOptions);
    console.log("✅ Email sent for sale:", saleData.Sale_id, "to:", userEmail);
    res.status(200).json({ message: "✅ Email notification sent successfully" });
  } catch (error) {
    console.error("❌ Email notification error:", {
      message: error.message,
      code: error.code,
      response: error.response ? {
        code: error.responseCode,
        command: error.command,
      } : null,
      stack: error.stack,
    });
    res.status(500).json({ message: "Failed to send email notification", error: error.message });
  }
});

app.post("/api/send-pdf-notification", verifyToken, async (req, res) => {
  const { userId, userEmail, pdfBase64, filename } = req.body;
  if (!userId || !userEmail || !pdfBase64 || !filename) {
    console.error("Missing required fields for PDF email", { userId, userEmail, filename });
    return res.status(400).json({
      message: "Missing required fields",
      missing: {
        userId: !userId,
        userEmail: !userEmail,
        pdfBase64: !pdfBase64,
        filename: !filename,
      },
    });
  }
  if (userId !== req.user.uid) {
    console.error("User ID mismatch", { requestUserId: userId, authUserId: req.user.uid });
    return res.status(403).json({ message: "User ID does not match authenticated user" });
  }
  try {
    const userDoc = await firestore.doc(`users/${userId}`).get();
    if (!userDoc.exists) {
      console.log("User document not found, creating default", { userId });
      await firestore.doc(`users/${userId}`).set({
        email: userEmail,
        settings: { emailNotifications: true, inventoryAlerts: true },
      }, { merge: true });
    }
    const userData = userDoc.exists ? userDoc.data() : { settings: { emailNotifications: true } };
    if (!userData?.settings?.emailNotifications) {
      console.log("Email notifications disabled for user", { userId, settings: userData?.settings });
      return res.status(200).json({ message: "Email notifications are disabled for this user" });
    }
    const mailOptions = {
      from: process.env.EMAIL_FROM || '"InventoryMW" <inventorymw@gmail.com>',
      to: userEmail,
      subject: `Sales and Expense Report - ${filename}`,
      html: `
        <h2>Sales and Expense Report</h2>
        <p>Dear User,</p>
        <p>Please find attached the Sales and Expense Report for the selected period.</p>
        <p>Thank you for using InventoryMW.</p>
        <p><em>This is an automated notification. Please do not reply.</em></p>
      `,
      attachments: [
        {
          filename,
          content: pdfBase64.split("base64,")[1] || pdfBase64,
          encoding: 'base64',
          contentType: 'application/pdf',
        },
      ],
    };
    await sendMailWithRetry(mailOptions);
    console.log("✅ PDF email sent to:", userEmail, "Filename:", filename);
    res.status(200).json({ message: "✅ PDF email sent successfully" });
  } catch (error) {
    console.error("❌ Error sending PDF email:", {
      message: error.message,
      code: error.code,
      response: error.response ? {
        code: error.responseCode,
        command: error.command,
      } : null,
      stack: error.stack,
    });
    res.status(500).json({ message: "Failed to send PDF email", error: error.message });
  }
});

app.get("/test-paychangu", async (req, res) => {
  try {
    const testPayload = {
      amount: "100",
      currency: "MWK",
      email: "test@example.com",
      first_name: "Test",
      last_name: "User",
      callback_url: "https://server-dmx8.onrender.com/payment-callback",
      return_url: "https://ibratechinnovations.com/subscription?status=completed",
      tx_ref: `test-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      customization: { title: "Test Payment", description: "Test transaction" },
      meta: { uuid: "test-user", phone: "+265990000000", provider: "airtel_money" },
    };
    const response = await callPayChanguAPI("payment", testPayload);
    console.log("Test PayChangu response:", JSON.stringify(response.data, null, 2));
    res.status(200).json({ message: "Test PayChangu API call successful", data: response.data });
  } catch (error) {
    console.error("Test PayChangu error:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack,
    });
    res.status(500).json({ message: "Test PayChangu API call failed", error: error.message });
  }
});

app.post("/api/start-trial", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  console.log("Starting 7-day trial for user:", { userId });
  try {
    const userRef = firestore.doc(`users/${userId}`);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    if (userData?.subscriptionenddate) {
      const endDate = new Date(userData.subscriptionenddate);
      const now = new Date();
      if (endDate > now) {
        console.error("User already has an active subscription or trial", {
          userId,
          endDate: endDate.toISOString(),
        });
        return res.status(400).json({ message: "You already have an active subscription or trial." });
      }
    }
    const currentDate = new Date();
    const endDate = new Date(currentDate);
    endDate.setDate(endDate.getDate() + 7);
    await userRef.set(
      {
        subscriptionstartdate: currentDate.toISOString(),
        subscriptionenddate: endDate.toISOString(),
        role: userData?.role || "user",
        hasUsedTrial: true,
      },
      { merge: true }
    );
    console.log("Trial started:", { userId, endDate: endDate.toISOString() });
    res.status(200).json({ message: "7-day trial started successfully", endDate: endDate.toISOString() });
  } catch (error) {
    console.error("Error starting trial:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: "Failed to start trial", error: error.message });
  }
});

app.post("/api/start-free-trial", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  console.log("Starting free trial for user:", { userId });
  try {
    const userRef = firestore.doc(`users/${userId}`);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    if (userData?.hasUsedTrial) {
      console.error("User already used free trial", { userId });
      return res.status(400).json({ message: "You have already used your free trial." });
    }
    if (userData?.subscriptionenddate) {
      const endDate = new Date(userData.subscriptionenddate);
      const now = new Date();
      if (endDate > now) {
        console.error("User already has an active subscription or trial", {
          userId,
          endDate: endDate.toISOString(),
        });
        return res.status(400).json({ message: "You already have an active subscription or trial." });
      }
    }
    const currentDate = new Date();
    const endDate = new Date(currentDate);
    endDate.setDate(endDate.getDate() + 3);
    await userRef.set(
      {
        subscriptionstartdate: currentDate.toISOString(),
        subscriptionenddate: endDate.toISOString(),
        role: userData?.role || "user",
        hasUsedTrial: true,
      },
      { merge: true }
    );
    console.log("Free trial started:", { userId, endDate: endDate.toISOString() });
    res.status(200).json({ message: "3-day free trial started successfully", endDate: endDate.toISOString() });
  } catch (error) {
    console.error("Error starting free trial:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ message: "Failed to start free trial", error: error.message });
  }
});

app.post("/api/charge-mobile-money", verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { amount = 4500, currency = "MWK", phone, provider } = req.body;
  if (!phone || !provider) {
    console.error("Missing required fields: phone or provider", { phone, provider });
    return res.status(400).json({ message: "Missing required fields: phone and provider" });
  }
  if (!phone.match(/^\+265(99|88)\d{7}$/)) {
    console.error("Invalid phone number format", { phone });
    return res.status(400).json({ message: "Invalid phone number format. Use +26599XXXXXX or +26588XXXXXX" });
  }
  const providerMapping = {
    airtel: "airtel_money",
    tnm: "tnm_mpamba",
  };
  if (!providerMapping[provider]) {
    console.error("Invalid provider", { provider });
    return res.status(400).json({ message: "Invalid provider. Use 'airtel' or 'tnm'" });
  }
  try {
    const userRecord = await admin.auth().getUser(userId);
    const firstName = userRecord.displayName ? userRecord.displayName.split(" ")[0] : "User";
    const lastName = userRecord.displayName ? userRecord.displayName.split(" ")[1] || "" : "";
    const txRef = `${userId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const callbackUrl = "https://server-dmx8.onrender.com/payment-callback";
    if (!callbackUrl.startsWith("https://")) {
      console.error("Invalid callback_url: Must be HTTPS", { callbackUrl });
      return res.status(500).json({ message: "Server configuration error: Invalid callback URL" });
    }
    const payChanguPayload = {
      amount: amount.toString(),
      currency,
      email: userRecord.email,
      first_name: firstName,
      last_name: lastName,
      callback_url: callbackUrl,
      return_url: "https://ibratechinnovations.com/subscription?status=completed",
      tx_ref: txRef,
      customization: {
        title: "InventoryMW Subscription",
        description: "Monthly subscription for InventoryMW access (4,500 MWK)",
      },
      meta: {
        uuid: userId,
        phone,
        provider: providerMapping[provider],
        response: "Subscription Payment",
      },
    };
    console.log("Sending PayChangu request:", JSON.stringify(payChanguPayload, null, 2));
    const payChanguResponse = await callPayChanguAPI("payment", payChanguPayload);
    console.log("PayChangu response:", JSON.stringify(payChanguResponse.data, null, 2));
    if (payChanguResponse.data.status === "success" && payChanguResponse.data.data?.checkout_url) {
      const paymentRef = firestore.doc(`users/${userId}/Payments/${txRef}`);
      await paymentRef.set({
        userId,
        email: userRecord.email,
        firstName,
        lastName,
        amount,
        currency,
        tx_ref: txRef,
        checkout_url: payChanguResponse.data.data.checkout_url,
        mode: "live",
        status: "pending",
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        phone,
        provider: providerMapping[provider],
      });
      res.status(200).json({
        message: "Mobile money payment initiated. Please complete on the next page.",
        checkout_url: payChanguResponse.data.data.checkout_url,
        tx_ref: txRef,
        status: "pending",
      });
    } else {
      console.error("Invalid PayChangu response:", JSON.stringify(payChanguResponse.data, null, 2));
      res.status(500).json({
        message: "Failed to initiate mobile money charge",
        error: payChanguResponse.data.message || "No checkout URL received",
      });
    }
  } catch (error) {
    console.error("Error initiating mobile money charge:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack,
    });
    let errorMessage = error.message;
    if (error.response?.data?.message) {
      errorMessage = typeof error.response.data.message === "string"
        ? error.response.data.message
        : JSON.stringify(error.response.data.message);
    }
    res.status(500).json({
      message: "Failed to initiate mobile money charge",
      error: errorMessage.includes("401") ? "Invalid PayChangu API key" : errorMessage,
    });
  }
});

app.get("/api/check-payment/:tx_ref", verifyToken, async (req, res) => {
  const { tx_ref } = req.params;
  const userId = req.user.uid;
  try {
    const paymentRef = firestore.doc(`users/${userId}/Payments/${tx_ref}`);
    const paymentDoc = await paymentRef.get();
    const paymentData = paymentDoc.data();
    if (!paymentDoc.exists || paymentData.userId !== userId) {
      console.error("Payment not found or unauthorized", { tx_ref, userId });
      return res.status(404).json({ message: "Payment not found or unauthorized" });
    }
    if (paymentData.status === "pending") {
      const response = await verifyPayment(tx_ref);
      console.log("Verify payment response:", JSON.stringify(response, null, 2));
      const isSuccessful = response.status === "success";
      if (isSuccessful) {
        const currentDate = new Date();
        const endDate = new Date(currentDate);
        endDate.setMonth(endDate.getMonth() + Math.floor(paymentData.amount / 4500));
        await paymentRef.update({
          status: "successful",
          verifiedAt: admin.firestore.Timestamp.fromDate(new Date()),
          start_date: currentDate.toISOString(),
          end_date: endDate.toISOString(),
        });
        await updateSubscription(userId, paymentData.amount);
        return res.status(200).json({ status: "successful", endDate: endDate.toISOString() });
      } else if (response.status === "failed") {
        await paymentRef.update({
          status: "failed",
          error: response.message || "Payment failed",
          verifiedAt: admin.firestore.Timestamp.fromDate(new Date()),
        });
        return res.status(200).json({ status: "failed", error: response.message });
      }
    }
    res.status(200).json({ status: mailOptions.status });
  } catch (error) {
    console.error("Error checking payment:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack,
    });
    res.status(500).json({ message: "Failed to check payment status", error: error.message });
  }
});

async function callPayChanguAPI(endpoint, payload, method = "post", retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const config = {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };
      let response;
      if (method === "post") {
        response = await axios.post(`https://api.paychangu.com/${endpoint}`, payload, config);
      } else {
        response = await axios.get(`https://api.paychangu.com/${endpoint}`, config);
      }
      return response;
    } catch (error) {
      console.error(`PayChangu API attempt ${attempt} failed for ${endpoint}:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      if (attempt < retries && (error.response?.status === 429 || error.code === "ECONNABORTED")) {
        await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, attempt)));
      } else {
        throw error;
      }
    }
  }
}

async function verifyPayment(tx_ref, retries = 3, delay = 1000) {
  try {
    const response = await callPayChanguAPI(`verify-payment/${tx_ref}`, null, "get", retries, delay);
    return response.data;
  } catch (error) {
    console.error("Verify payment error:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    if (error.response?.status === 400 && error.response?.data?.message === "Payment transaction not created.") {
      return { status: "failed", message: "Payment transaction not created" };
    }
    throw error;
  }
}

async function updateSubscription(userId, amount) {
  try {
    const userRef = firestore.doc(`users/${userId}`);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    const now = new Date();
    let startDate = now;
    let endDate = new Date(now);
    if (userData?.subscriptionenddate) {
      const currentEnd = new Date(userData.subscriptionenddate);
      startDate = currentEnd > now ? currentEnd : now;
    }
    const months = Math.floor(amount / 4500);
    endDate.setMonth(startDate.getMonth() + months);
    await userRef.set(
      {
        subscriptionstartdate: startDate.toISOString(),
        subscriptionenddate: endDate.toISOString(),
        hasUsedTrial: userData?.hasUsedTrial || false,
      },
      { merge: true }
    );
    console.log("Subscription updated:", {
      userId,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });
  } catch (error) {
    console.error("Error updating subscription:", {
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

app.get("/payment-callback", async (req, res) => {
  console.log("Payment callback received:", {
    query: req.query,
    headers: req.headers,
    url: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
  const { tx_ref, status } = req.query;
  if (!tx_ref) {
    console.error("Missing tx_ref in callback");
    return res.redirect(
      `https://ibratechinnovations.com/subscription?status=not paid&error=${encodeURIComponent(
        "Missing transaction reference"
      )}`
    );
  }
  const userId = tx_ref.split("-")[0];
  if (!userId) {
    console.error("Invalid tx_ref format", { tx_ref });
    return res.redirect(
      `https://ibratechinnovations.com/subscription?status=not paid&error=${encodeURIComponent(
        "Invalid transaction reference format"
      )}`
    );
  }
  try {
    const response = await verifyPayment(tx_ref);
    console.log("PayChangu verification response:", JSON.stringify(response, null, 2));
    const isSuccessful = response.status === "success";
    const paymentRef = firestore.doc(`users/${userId}/Payments/${tx_ref}`);
    const paymentDoc = await paymentRef.get();
    const paymentData = paymentDoc.data() || {};
    await paymentRef.set(
      {
        status: isSuccessful ? "successful" : "failed",
        verifiedAt: admin.firestore.Timestamp.fromDate(new Date()),
        error: isSuccessful ? null : response.message || "Verification failed",
        payChanguResponse: response,
      },
      { merge: true }
    );
    if (isSuccessful) {
      await updateSubscription(userId, paymentData.amount || 4500);
      console.log("Subscription updated for user:", { userId, tx_ref });
    } else {
      console.warn("Payment verification failed:", { tx_ref, response });
    }
    res.redirect(
      `https://ibratechinnovations.com/subscription?status=${isSuccessful ? "paid" : "not paid"}&tx_ref=${tx_ref}`
    );
  } catch (error) {
    console.error("Error in callback:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack,
    });
    res.redirect(
      `https://ibratechinnovations.com/subscription?status=not paid&error=${encodeURIComponent(
        error.response?.data?.message || error.message
      )}`
    );
  }
});

app.post("/api/payment-webhook", async (req, res) => {
  console.log("Payment webhook received:", {
    body: req.body,
    headers: req.headers,
    timestamp: new Date().toISOString(),
  });
  const { tx_ref, meta } = req.body;
  const userId = meta?.uuid || (tx_ref ? tx_ref.split("-")[0] : null);
  if (!tx_ref || !userId) {
    console.error("Missing webhook parameters", { body: req.body });
    return res.status(400).json({ message: "Missing required webhook parameters" });
  }
  try {
    const response = await verifyPayment(tx_ref);
    console.log("PayChangu verification response (webhook):", JSON.stringify(response, null, 2));
    const isSuccessful = response.status === "success";
    const paymentRef = firestore.doc(`users/${userId}/Payments/${tx_ref}`);
    const paymentDoc = await paymentRef.get();
    const paymentData = paymentDoc.data() || {};
    await paymentRef.set(
      {
        status: isSuccessful ? "successful" : "failed",
        verifiedAt: admin.firestore.Timestamp.fromDate(new Date()),
        error: isSuccessful ? null : response.message || "Verification failed",
      },
      { merge: true }
    );
    if (isSuccessful) {
      await updateSubscription(userId, paymentData.amount || 4500);
    }
    res.status(200).json({ message: "Webhook processed" });
  } catch (error) {
    console.error("Error processing webhook:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack,
    });
    res.status(500).json({ message: "Server error in webhook", error: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error("Unexpected error:", {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  });
  res.status(500).json({ message: "Internal Server Error", error: err.message });
});

async function startServer() {
  try {
    await initializeFirebase();
    await verifyNodemailer();
    app.listen(PORT, () => {
      console.log(`🚀 Server running at https://server-dmx8.onrender.com/`);
    });
  } catch (error) {
    console.error("Failed to initialize server:", {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

startServer();