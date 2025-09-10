const express = require("express");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://ibratechinventorysystem.netlify.app',
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Firebase Admin setup
const serviceAccount = {
  projectId: process.env.PROJECT_ID,
  clientEmail: process.env.CLIENT_EMAIL,
  privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"),
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://inventorymanagementsyste-23fed-default-rtdb.firebaseio.com",
});

const db = admin.database();

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  logger: true,
  debug: true,
});

// Verify Nodemailer setup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Nodemailer error:", error.message);
  } else {
    console.log("✅ Nodemailer transporter ready");
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ Backend is running!");
});

// Test email
app.get("/test-email", async (req, res) => {
  const mailOptions = {
    from: `"InventoryMW" <${process.env.EMAIL_USER}>`,
    to: "test@example.com",
    subject: "Test Email from InventoryMW",
    text: "This is a test email to verify Nodemailer configuration.",
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "✅ Test email sent successfully" });
  } catch (error) {
    console.error("❌ Test email error:", error.message);
    res.status(500).json({ message: "❌ Failed to send test email", error: error.message });
  }
});

// Send email notification for sales
app.post("/api/send-email-notification", async (req, res) => {
  const { userId, userEmail, saleData, cartItems, totalAmount } = req.body;

  if (!userId || !userEmail || !saleData || !cartItems || !totalAmount) {
    console.error("Missing required fields", req.body);
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const userRecord = await admin.auth().getUser(userId);
    if (userRecord.email !== userEmail) {
      console.error("Email mismatch", { userId, userEmail, authEmail: userRecord.email });
      return res.status(400).json({ message: "Email does not match user ID" });
    }
  } catch (error) {
    console.error("Error verifying user", error.message);
    return res.status(400).json({ message: "Invalid user ID", error: error.message });
  }

  const emailSubject = `New Sale Completed - ${saleData.Saledate}`;
  let emailBody = `
    <h2>Sale Notification</h2>
    <p>Dear User,</p>
    <p>A new sale has been completed in your inventory system.</p>
    <p><strong>Sale ID:</strong> ${saleData.Sale_id}</p>
    <p><strong>Date:</strong> ${saleData.Saledate}</p>
    <p><strong>Total Amount:</strong> MK ${totalAmount.toLocaleString()}</p>
    <h3>Items Sold:</h3>
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
        <td>MK ${item.price.toLocaleString()}</td>
        <td>MK ${item.total.toLocaleString()}</td>
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
    from: `"InventoryMW" <${process.env.EMAIL_USER}>`,
    to: userEmail,
    subject: emailSubject,
    html: emailBody,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent for sale:", saleData.Sale_id);
    res.status(200).json({ message: "✅ Email notification sent successfully" });
  } catch (error) {
    console.error("❌ Email error:", error.message);
    res.status(500).json({ message: "❌ Failed to send email", error: error.message });
  }
});

// Retry helper for PayChangu API
async function callPayChanguAPI(payload, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        "https://api.paychangu.com/payment",
        payload,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      return response;
    } catch (error) {
      console.error(`PayChangu API attempt ${attempt} failed:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      if (attempt < retries && (error.response?.status === 429 || error.code === 'ECONNABORTED')) {
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

// Initiate PayChangu Standard Checkout
app.post("/api/initiate-payment", async (req, res) => {
  const { userId, email, firstName, lastName, amount = 15000, currency = "MWK" } = req.body;

  console.log("Received payment initiation request:", req.body);

  if (!userId || !email || !firstName) {
    console.error("Missing required payment fields", req.body);
    return res.status(400).json({ message: "Missing required fields for payment initiation", error: "userId, email, and firstName are required" });
  }

  try {
    // Verify user in Firebase Auth
    const userRecord = await admin.auth().getUser(userId);
    if (userRecord.email !== email) {
      console.error("Email mismatch", { userId, providedEmail: email, authEmail: userRecord.email });
      return res.status(400).json({ message: "Email does not match user ID", error: "Invalid email" });
    }

    // Generate unique tx_ref
    const txRef = `${userId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // Call PayChangu API with retry
    const payChanguResponse = await callPayChanguAPI({
      amount: amount.toString(),
      currency,
      email,
      first_name: firstName,
      last_name: lastName || "",
      callback_url: "https://server-dmx8.onrender.com/payment-callback",
      return_url: "http://localhost:5173/subscribe",
      tx_ref: txRef,
      customization: {
        title: "InventoryMW Subscription",
        description: "Monthly subscription for InventoryMW access (15,000 MWK)",
      },
      meta: {
        uuid: userId,
        user_name: `${firstName} ${lastName || ""}`.trim(),
      },
    });

    console.log("PayChangu payment response:", JSON.stringify(payChanguResponse.data, null, 2));

    if (payChanguResponse.data.status === "success" && payChanguResponse.data.data?.checkout_url) {
      res.status(200).json({
        message: "Payment initiated successfully",
        checkout_url: payChanguResponse.data.data.checkout_url,
        tx_ref: txRef,
        mode: payChanguResponse.data.data.mode || 'sandbox',
      });
    } else {
      console.error("Invalid PayChangu response:", payChanguResponse.data);
      res.status(500).json({
        message: "Failed to initiate payment",
        error: payChanguResponse.data.message || "No checkout URL received",
        tx_ref: txRef,
      });
    }
  } catch (error) {
    console.error("Error initiating payment:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    res.status(500).json({
      message: "Failed to initiate payment",
      error: error.response?.data?.message || error.message,
      tx_ref: `${userId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    });
  }
});

// Helper function to verify payment with retries
async function verifyPayment(tx_ref, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(`https://api.paychangu.com/verify-payment/${tx_ref}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
        },
        timeout: 10000,
      });
      return response.data;
    } catch (error) {
      console.error(`Verification attempt ${attempt} failed for tx_ref ${tx_ref}:`, {
        message: error.message,
        response: error.response?.data,
      });
      if (attempt < retries && (error.response?.status === 429 || error.code === 'ECONNABORTED')) {
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

// Payment callback from PayChangu (GET)
app.get("/payment-callback", async (req, res) => {
  const { tx_ref } = req.query;

  console.log("Payment callback received:", { query: req.query });

  // Extract userId from tx_ref
  let userId = null;
  if (tx_ref) {
    const parts = tx_ref.split('-');
    if (parts.length >= 3) {
      userId = parts[0]; // Assuming tx_ref format is {userId}-{timestamp}-{random}
      console.log("Extracted userId from tx_ref:", userId);
    }
  }

  if (!tx_ref || !userId) {
    console.error("Missing critical callback parameters", { query: req.query, extractedUserId: userId });
    return res.redirect(
      `http://localhost:5173/subscribe?status=not paid&error=${encodeURIComponent("Missing transaction reference or user ID")}`
    );
  }

  try {
    // Verify payment with PayChangu API
    const response = await verifyPayment(tx_ref);
    console.log("PayChangu verification response:", JSON.stringify(response, null, 2));

    const paymentData = response;
    const isSuccessful = paymentData.status === "success";

    // Verify user exists
    let email = paymentData.customer?.email || "unknown";
    let user_name = paymentData.meta?.user_name || "unknown";
    try {
      const userRecord = await admin.auth().getUser(userId);
      console.log("User verified:", userId);
      email = userRecord.email || email;
      user_name = userRecord.displayName || user_name;
    } catch (error) {
      console.error("Invalid user ID in payment callback", { userId, error: error.message });
      const paymentRef = db.ref(`Payments/${tx_ref}`);
      try {
        await paymentRef.set({
          userId,
          email,
          user_name,
          tx_ref,
          amount: paymentData.amount || 15000,
          currency: paymentData.currency || "MWK",
          paymentDate: new Date().toISOString(),
          status: "failed",
          error: "Invalid user ID",
          verifiedAt: Date.now(),
        });
        console.log("Updated payment to failed:", { userId, tx_ref });
      } catch (dbError) {
        console.error("Firebase write error in callback:", dbError.message);
      }
      return res.redirect(
        `http://localhost:5173/subscribe?status=not paid&error=${encodeURIComponent("Invalid user ID")}`
      );
    }

    // Update payment record
    const paymentRef = db.ref(`Payments/${tx_ref}`);
    console.log("Creating Firebase reference:", `Payments/${tx_ref}`);
    try {
      await paymentRef.set({
        userId,
        email,
        firstName: user_name.split(' ')[0] || "User",
        lastName: user_name.split(' ')[1] || "",
        amount: paymentData.amount || 15000,
        currency: paymentData.currency || "MWK",
        tx_ref,
        checkout_url: paymentData.checkout_url || "unknown",
        mode: paymentData.mode || "sandbox",
        status: isSuccessful ? "successful" : "failed",
        paymentMethod: paymentData.authorization?.channel || "unknown",
        transactionId: paymentData.reference || "unknown",
        verifiedAt: Date.now(),
        error: isSuccessful ? null : `Verification failed: ${paymentData.status || "unknown"}`,
        createdAt: new Date(paymentData.created_at).getTime() || Date.now(),
      });
      console.log(`Updated payment to ${isSuccessful ? "successful" : "failed"}:`, { userId, tx_ref });
    } catch (dbError) {
      console.error("Firebase write error in callback:", dbError.message);
      return res.redirect(
        `http://localhost:5173/subscribe?status=not paid&error=${encodeURIComponent("Server error updating payment")}`
      );
    }

    // Update subscription end date for successful payment
    if (isSuccessful) {
      const currentDate = new Date();
      currentDate.setMonth(currentDate.getMonth() + 1);
      const subscriptionEndDate = currentDate.toISOString().split("T")[0];
      const subscriptionRef = db.ref(`users/${userId}/subscriptionEndDate`);
      try {
        await subscriptionRef.set(subscriptionEndDate);
        console.log("Subscription updated:", { userId, subscriptionEndDate });
      } catch (dbError) {
        console.error("Firebase write error for subscription:", dbError.message);
      }
    }

    res.redirect(
      `http://localhost:5173/subscribe?status=${isSuccessful ? "paid" : "not paid"}` +
      (isSuccessful ? "" : `&error=${encodeURIComponent("Payment verification failed")}`)
    );
  } catch (error) {
    console.error("Error verifying payment:", {
      message: error.message,
      response: error.response?.data,
    });
    const paymentRef = db.ref(`Payments/${tx_ref}`);
    try {
      await paymentRef.set({
        userId,
        email: "unknown",
        user_name: "unknown",
        tx_ref,
        amount: 15000,
        currency: "MWK",
        paymentDate: new Date().toISOString(),
        status: "failed",
        error: error.response?.data?.message || error.message,
        verifiedAt: Date.now(),
        createdAt: Date.now(),
      });
      console.log("Updated payment to failed:", { userId, tx_ref });
    } catch (dbError) {
      console.error("Firebase write error in callback:", dbError.message);
    }
    return res.redirect(
      `http://localhost:5173/subscribe?status=not paid&error=${encodeURIComponent("Payment verification error")}`
    );
  }
});

// Webhook endpoint for PayChangu (POST)
app.post("/api/payment-webhook", async (req, res) => {
  const { tx_ref, meta } = req.body;
  const userId = meta?.uuid || (tx_ref ? tx_ref.split('-')[0] : null);

  console.log("Payment webhook received:", { tx_ref, userId, body: req.body });

  if (!tx_ref || !userId) {
    console.error("Missing webhook parameters", { body: req.body });
    return res.status(400).json({ message: "Missing required webhook parameters" });
  }

  try {
    // Verify payment
    const response = await verifyPayment(tx_ref);
    console.log("PayChangu verification response (webhook):", JSON.stringify(response, null, 2));

    const paymentData = response;
    const isSuccessful = paymentData.status === "success";

    // Verify user
    let email = paymentData.customer?.email || "unknown";
    let user_name = paymentData.meta?.user_name || "unknown";
    try {
      const userRecord = await admin.auth().getUser(userId);
      console.log("User verified (webhook):", userId);
      email = userRecord.email || email;
      user_name = userRecord.displayName || user_name;
    } catch (error) {
      console.error("Invalid user ID in webhook", { userId, error: error.message });
      const paymentRef = db.ref(`Payments/${tx_ref}`);
      try {
        await paymentRef.set({
          userId,
          email,
          user_name,
          tx_ref,
          amount: paymentData.amount || 15000,
          currency: paymentData.currency || "MWK",
          paymentDate: new Date().toISOString(),
          status: "failed",
          error: "Invalid user ID",
          verifiedAt: Date.now(),
        });
        console.log("Updated payment to failed (webhook):", { userId, tx_ref });
      } catch (dbError) {
        console.error("Firebase write error in webhook:", dbError.message);
      }
      return res.status(200).json({ message: "Webhook processed" });
    }

    // Update payment record
    const paymentRef = db.ref(`Payments/${tx_ref}`);
    console.log("Creating Firebase reference (webhook):", `Payments/${tx_ref}`);
    try {
      await paymentRef.set({
        userId,
        email,
        firstName: user_name.split(' ')[0] || "User",
        lastName: user_name.split(' ')[1] || "",
        amount: paymentData.amount || 15000,
        currency: paymentData.currency || "MWK",
        tx_ref,
        checkout_url: paymentData.checkout_url || "unknown",
        mode: paymentData.mode || "sandbox",
        status: isSuccessful ? "successful" : "failed",
        paymentMethod: paymentData.authorization?.channel || "unknown",
        transactionId: paymentData.reference || "unknown",
        verifiedAt: Date.now(),
        error: isSuccessful ? null : `Verification failed: ${paymentData.status || "unknown"}`,
        createdAt: new Date(paymentData.created_at).getTime() || Date.now(),
      });
      console.log(`Updated payment to ${isSuccessful ? "successful" : "failed"} (webhook):`, { userId, tx_ref });
    } catch (dbError) {
      console.error("Firebase write error in webhook:", dbError.message);
      return res.status(200).json({ message: "Webhook processed with database error" });
    }

    // Update subscription end date for successful payment
    if (isSuccessful) {
      const currentDate = new Date();
      currentDate.setMonth(currentDate.getMonth() + 1);
      const subscriptionEndDate = currentDate.toISOString().split("T")[0];
      const subscriptionRef = db.ref(`users/${userId}/subscriptionEndDate`);
      try {
        await subscriptionRef.set(subscriptionEndDate);
        console.log("Subscription updated (webhook):", { userId, subscriptionEndDate });
      } catch (dbError) {
        console.error("Firebase write error for subscription (webhook):", dbError.message);
      }
    }

    return res.status(200).json({ message: "Webhook processed" });
  } catch (error) {
    console.error("Error processing webhook:", {
      message: error.message,
      response: error.response?.data,
    });
    const paymentRef = db.ref(`Payments/${tx_ref}`);
    try {
      await paymentRef.set({
        userId,
        email: "unknown",
        user_name: "unknown",
        tx_ref,
        amount: 15000,
        currency: "MWK",
        paymentDate: new Date().toISOString(),
        status: "failed",
        error: error.response?.data?.message || error.message,
        verifiedAt: Date.now(),
        createdAt: Date.now(),
      });
      console.log("Updated payment to failed (webhook):", { userId, tx_ref });
    } catch (dbError) {
      console.error("Firebase write error in webhook:", dbError.message);
    }
    return res.status(200).json({ message: "Webhook processed" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at https://server-dmx8.onrender.com/`);
});