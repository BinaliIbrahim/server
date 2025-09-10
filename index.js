import express from "express";
import nodemailer from "nodemailer";
import admin from "firebase-admin";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { getDatabase } from "firebase-admin/database";

// Load environment variables
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

const db = getDatabase();

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

// Initiate PayChangu Standard Checkout
app.post("/api/initiate-payment", async (req, res) => {
  const { userId, email, firstName, lastName, amount = 15000, currency = "MWK" } = req.body;

  console.log("Received payment initiation request:", req.body);

  if (!userId || !email || !firstName) {
    console.error("Missing required payment fields", req.body);
    return res.status(400).json({ message: "Missing required fields for payment initiation" });
  }

  try {
    // Verify user in Firebase Auth
    const userRecord = await admin.auth().getUser(userId);
    if (userRecord.email !== email) {
      console.error("Email mismatch", { userId, providedEmail: email, authEmail: userRecord.email });
      return res.status(400).json({ message: "Email does not match user ID" });
    }

    // Generate unique tx_ref
    const txRef = `${userId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // Call PayChangu API
    const payChanguResponse = await axios.post(
      "https://api.paychangu.com/payment",
      {
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
      },
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${process.env.PAYCHANGU_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("PayChangu payment response:", payChanguResponse.data);

    if (payChanguResponse.data.status === "success" && payChanguResponse.data.data.checkout_url) {
      // Save initial payment attempt to database
      const paymentRef = db.ref(`users/${userId}/subscriptions`);
      const newPaymentRef = paymentRef.push();
      await newPaymentRef.set({
        tx_ref: txRef,
        amount: amount,
        currency: currency,
        paymentDate: new Date().toISOString(),
        status: "pending",
        email: email,
        user_name: `${firstName} ${lastName || ""}`.trim(),
        updatedAt: new Date().toISOString(),
      });
      console.log("Initial payment recorded:", { userId, txRef });

      res.status(200).json({
        message: "Payment initiated successfully",
        checkout_url: payChanguResponse.data.data.checkout_url,
      });
    } else {
      console.error("Invalid PayChangu response:", payChanguResponse.data);
      res.status(500).json({ message: "Failed to initiate payment", error: payChanguResponse.data.message });
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
      });
      return response.data;
    } catch (error) {
      console.error(`Verification attempt ${attempt} failed for tx_ref ${tx_ref}:`, {
        message: error.message,
        response: error.response?.data,
      });
      if (attempt < retries) {
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
    if (userId && tx_ref) {
      const paymentRef = db.ref(`users/${userId}/subscriptions`).orderByChild("tx_ref").equalTo(tx_ref);
      const snapshot = await paymentRef.once("value");
      if (!snapshot.exists()) {
        const newPaymentRef = db.ref(`users/${userId}/subscriptions`).push();
        await newPaymentRef.set({
          tx_ref,
          amount: 15000,
          currency: "MWK",
          paymentDate: new Date().toISOString(),
          status: "not paid",
          error: "Missing transaction reference or user ID",
          updatedAt: new Date().toISOString(),
        });
        console.log("Created not paid record:", { userId, txRef });
      } else {
        console.log("Skipping duplicate record for tx_ref:", tx_ref);
      }
    }
    return res.redirect(
      `http://localhost:5173/subscribe?status=not paid&error=${encodeURIComponent("Missing transaction reference or user ID")}`
    );
  }

  // Check for recent processing to avoid duplicates
  const paymentRef = db.ref(`users/${userId}/subscriptions`).orderByChild("tx_ref").equalTo(tx_ref);
  const snapshot = await paymentRef.once("value");
  if (snapshot.exists()) {
    const paymentData = Object.values(snapshot.val())[0];
    const updatedAt = new Date(paymentData.updatedAt);
    const now = new Date();
    const timeDiff = (now - updatedAt) / 1000 / 60; // Time difference in minutes
    if (timeDiff < 5 && paymentData.status !== "pending") {
      console.log("Ignoring duplicate callback for tx_ref:", tx_ref);
      return res.redirect(
        `http://localhost:5173/subscribe?status=${paymentData.status}&error=${encodeURIComponent(paymentData.error || "")}`
      );
    }
  }

  try {
    // Verify payment with PayChangu API
    const response = await verifyPayment(tx_ref);
    console.log("PayChangu verification response:", JSON.stringify(response.data, null, 2));

    const paymentData = response.data;
    const isPaid = paymentData.status === "success" && paymentData.data?.status === "success";

    // Verify user exists
    try {
      const userRecord = await admin.auth().getUser(userId);
      console.log("User verified:", userId);
      // Use fallback email and name from pending record or Firebase Auth
      let email = paymentData.data?.email || userRecord.email || "unknown";
      let user_name = paymentData.data?.meta?.user_name || userRecord.displayName || "unknown";
      if (snapshot.exists()) {
        const existingData = Object.values(snapshot.val())[0];
        email = email !== "unknown" ? email : existingData.email || "unknown";
        user_name = user_name !== "unknown" ? user_name : existingData.user_name || "unknown";
      }

      // Update subscription end date for paid status
      let subscriptionEndDate = null;
      if (isPaid) {
        const currentDate = new Date();
        currentDate.setMonth(currentDate.getMonth() + 1);
        subscriptionEndDate = currentDate.toISOString().split("T")[0];
        const subscriptionRef = db.ref(`users/${userId}/subscriptionEndDate`);
        await subscriptionRef.set(subscriptionEndDate);
        console.log("Subscription updated:", { userId, subscriptionEndDate });
      }

      // Update or create payment record
      if (snapshot.exists()) {
        const paymentKey = Object.keys(snapshot.val())[0];
        await db.ref(`users/${userId}/subscriptions/${paymentKey}`).update({
          status: isPaid ? "paid" : "not paid",
          subscriptionEndDate: subscriptionEndDate || null,
          amount: paymentData.data?.amount || 15000,
          currency: paymentData.data?.currency || "MWK",
          paymentMethod: paymentData.data?.payment_method || "unknown",
          email,
          user_name,
          updatedAt: new Date().toISOString(),
          error: isPaid ? null : `Verification failed: ${paymentData.status || "unknown"}`,
        });
        console.log(`Payment record updated to ${isPaid ? "paid" : "not paid"}:`, { userId, txRef });
      } else {
        const newPaymentRef = db.ref(`users/${userId}/subscriptions`).push();
        await newPaymentRef.set({
          tx_ref,
          amount: paymentData.data?.amount || 15000,
          currency: paymentData.data?.currency || "MWK",
          paymentDate: new Date().toISOString(),
          status: isPaid ? "paid" : "not paid",
          subscriptionEndDate: subscriptionEndDate || null,
          paymentMethod: paymentData.data?.payment_method || "unknown",
          email,
          user_name,
          updatedAt: new Date().toISOString(),
          error: isPaid ? null : `Verification failed: ${paymentData.status || "unknown"}`,
        });
        console.log(`Created ${isPaid ? "paid" : "not paid"} payment record:`, { userId, txRef });
      }

      res.redirect(
        `http://localhost:5173/subscribe?status=${isPaid ? "paid" : "not paid"}` +
        (isPaid ? "" : `&error=${encodeURIComponent("Payment verification failed")}`)
      );
    } catch (error) {
      console.error("Invalid user ID in payment callback", { userId, error: error.message });
      if (snapshot.exists()) {
        const paymentKey = Object.keys(snapshot.val())[0];
        await db.ref(`users/${userId}/subscriptions/${paymentKey}`).update({
          status: "not paid",
          updatedAt: new Date().toISOString(),
          error: "Invalid user ID",
        });
        console.log("Updated payment status to not paid:", { userId, txRef });
      } else {
        const newPaymentRef = db.ref(`users/${userId}/subscriptions`).push();
        await newPaymentRef.set({
          tx_ref,
          amount: 15000,
          currency: "MWK",
          paymentDate: new Date().toISOString(),
          status: "not paid",
          error: "Invalid user ID",
          updatedAt: new Date().toISOString(),
        });
        console.log("Created not paid payment record:", { userId, txRef });
      }
      return res.redirect(
        `http://localhost:5173/subscribe?status=not paid&error=${encodeURIComponent("Invalid user ID")}`
      );
    }
  } catch (error) {
    console.error("Error verifying payment:", {
      message: error.message,
      response: error.response?.data,
    });
    if (snapshot.exists()) {
      const paymentKey = Object.keys(snapshot.val())[0];
      await db.ref(`users/${userId}/subscriptions/${paymentKey}`).update({
        status: "not paid",
        updatedAt: new Date().toISOString(),
        error: error.response?.data?.message || error.message,
      });
      console.log("Updated payment status to not paid:", { userId, txRef });
    } else {
      const newPaymentRef = db.ref(`users/${userId}/subscriptions`).push();
      await newPaymentRef.set({
        tx_ref,
        amount: 15000,
        currency: "MWK",
        paymentDate: new Date().toISOString(),
        status: "not paid",
        error: error.response?.data?.message || error.message,
        updatedAt: new Date().toISOString(),
      });
      console.log("Created not paid payment record:", { userId, txRef });
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

  // Check for recent processing to avoid duplicates
  const paymentRef = db.ref(`users/${userId}/subscriptions`).orderByChild("tx_ref").equalTo(tx_ref);
  const snapshot = await paymentRef.once("value");
  if (snapshot.exists()) {
    const paymentData = Object.values(snapshot.val())[0];
    const updatedAt = new Date(paymentData.updatedAt);
    const now = new Date();
    const timeDiff = (now - updatedAt) / 1000 / 60; // Time difference in minutes
    if (timeDiff < 5 && paymentData.status !== "pending") {
      console.log("Ignoring duplicate webhook for tx_ref:", tx_ref);
      return res.status(200).json({ message: "Webhook processed (duplicate)" });
    }
  }

  try {
    // Verify payment
    const response = await verifyPayment(tx_ref);
    console.log("PayChangu verification response (webhook):", JSON.stringify(response.data, null, 2));

    const paymentData = response.data;
    const isPaid = paymentData.status === "success" && paymentData.data?.status === "success";

    // Verify user
    try {
      const userRecord = await admin.auth().getUser(userId);
      console.log("User verified (webhook):", userId);
      let email = paymentData.data?.email || userRecord.email || "unknown";
      let user_name = paymentData.data?.meta?.user_name || userRecord.displayName || "unknown";
      if (snapshot.exists()) {
        const existingData = Object.values(snapshot.val())[0];
        email = email !== "unknown" ? email : existingData.email || "unknown";
        user_name = user_name !== "unknown" ? user_name : existingData.user_name || "unknown";
      }

      // Update subscription end date for paid status
      let subscriptionEndDate = null;
      if (isPaid) {
        const currentDate = new Date();
        currentDate.setMonth(currentDate.getMonth() + 1);
        subscriptionEndDate = currentDate.toISOString().split("T")[0];
        const subscriptionRef = db.ref(`users/${userId}/subscriptionEndDate`);
        await subscriptionRef.set(subscriptionEndDate);
        console.log("Subscription updated (webhook):", { userId, subscriptionEndDate });
      }

      // Update or create payment record
      if (snapshot.exists()) {
        const paymentKey = Object.keys(snapshot.val())[0];
        await db.ref(`users/${userId}/subscriptions/${paymentKey}`).update({
          status: isPaid ? "paid" : "not paid",
          subscriptionEndDate: subscriptionEndDate || null,
          amount: paymentData.data?.amount || 15000,
          currency: paymentData.data?.currency || "MWK",
          paymentMethod: paymentData.data?.payment_method || "unknown",
          email,
          user_name,
          updatedAt: new Date().toISOString(),
          error: isPaid ? null : `Verification failed: ${paymentData.status || "unknown"}`,
        });
        console.log(`Payment record updated to ${isPaid ? "paid" : "not paid"} (webhook):`, { userId, txRef });
      } else {
        const newPaymentRef = db.ref(`users/${userId}/subscriptions`).push();
        await newPaymentRef.set({
          tx_ref,
          amount: paymentData.data?.amount || 15000,
          currency: paymentData.data?.currency || "MWK",
          paymentDate: new Date().toISOString(),
          status: isPaid ? "paid" : "not paid",
          subscriptionEndDate: subscriptionEndDate || null,
          paymentMethod: paymentData.data?.payment_method || "unknown",
          email,
          user_name,
          updatedAt: new Date().toISOString(),
          error: isPaid ? null : `Verification failed: ${paymentData.status || "unknown"}`,
        });
        console.log(`Created ${isPaid ? "paid" : "not paid"} payment record (webhook):`, { userId, txRef });
      }

      return res.status(200).json({ message: "Webhook processed" });
    } catch (error) {
      console.error("Invalid user ID in webhook", { userId, error: error.message });
      if (snapshot.exists()) {
        const paymentKey = Object.keys(snapshot.val())[0];
        await db.ref(`users/${userId}/subscriptions/${paymentKey}`).update({
          status: "not paid",
          updatedAt: new Date().toISOString(),
          error: "Invalid user ID",
        });
        console.log("Updated payment status to not paid:", { userId, txRef });
      } else {
        const newPaymentRef = db.ref(`users/${userId}/subscriptions`).push();
        await newPaymentRef.set({
          tx_ref,
          amount: 15000,
          currency: "MWK",
          paymentDate: new Date().toISOString(),
          status: "not paid",
          error: "Invalid user ID",
          updatedAt: new Date().toISOString(),
        });
        console.log("Created not paid payment record:", { userId, txRef });
      }
      return res.status(200).json({ message: "Webhook processed" });
    }
  } catch (error) {
    console.error("Error processing webhook:", {
      message: error.message,
      response: error.response?.data,
    });
    if (snapshot.exists()) {
      const paymentKey = Object.keys(snapshot.val())[0];
      await db.ref(`users/${userId}/subscriptions/${paymentKey}`).update({
        status: "not paid",
        updatedAt: new Date().toISOString(),
        error: error.response?.data?.message || error.message,
      });
      console.log("Updated payment status to not paid (webhook):", { userId, txRef });
    } else {
      const newPaymentRef = db.ref(`users/${userId}/subscriptions`).push();
      await newPaymentRef.set({
        tx_ref,
        amount: 15000,
        currency: "MWK",
        paymentDate: new Date().toISOString(),
        status: "not paid",
        error: error.response?.data?.message || error.message,
        updatedAt: new Date().toISOString(),
      });
      console.log("Created not paid payment record (webhook):", { userId, txRef });
    }
    return res.status(200).json({ message: "Webhook processed" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at https://server-dmx8.onrender.com/`);
});