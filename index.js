const express = require("express");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const cors = require("cors");
const serviceAccount = require("./serviceAccountKey.json");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://inventorymanagementsyste-23fed-default-rtdb.firebaseio.com",
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // Use TLS
  auth: {
    user: "demdibouy@gmail.com",
    pass: "oivemkmpoyxoepzf", // Replace with your new Gmail App Password
  },
  logger: true, // Enable logging
  debug: true, // Show debug output
});

// Verify Nodemailer transporter on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("Nodemailer verification failed:", {
      message: error.message,
      code: error.code,
      response: error.response,
    });
  } else {
    console.log("Nodemailer transporter is ready to send emails");
  }
});

// API check
app.get("/", (req, res) => {
  res.send("Backend is running!");
});

// Send email notification
app.post("/api/send-email-notification", async (req, res) => {
  const { userId, userEmail, saleData, cartItems, totalAmount } = req.body;

  if (!userId || !userEmail || !saleData || !cartItems || !totalAmount) {
    console.error("Missing required fields", { requestBody: req.body });
    return res.status(400).json({ message: "Missing required fields" });
  }

  // Verify user exists in Firebase Auth
  try {
    const userRecord = await admin.auth().getUser(userId);
    if (userRecord.email !== userEmail) {
      console.error("Email mismatch", { userId, providedEmail: userEmail, authEmail: userRecord.email });
      return res.status(400).json({ message: "Email does not match user ID" });
    }
  } catch (error) {
    console.error("Error verifying user", { error: error.message });
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
    <p><em>This is an automated notification. Please do not reply to this email.</em></p>
  `;

  const mailOptions = {
    from: '"InventoryMW" <demdibouy@gmail.com>',
    to: userEmail,
    subject: emailSubject,
    html: emailBody,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Email notification sent", { userId, saleId: saleData.Sale_id });
    res.status(200).json({ message: "Email notification sent successfully" });
  } catch (error) {
    console.error("Error sending email notification", {
      message: error.message,
      code: error.code,
      response: error.response,
    });
    res.status(500).json({ message: "Failed to send email notification", error: error.message });
  }
});

// Test email endpoint
app.get("/test-email", async (req, res) => {
  const mailOptions = {
    from: '"InventoryMW" <demdibouy@gmail.com>',
    to: "test@example.com",
    subject: "Test Email from InventoryMW",
    text: "This is a test email to verify Nodemailer configuration.",
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("Test email sent successfully");
    res.status(200).json({ message: "Test email sent successfully" });
  } catch (error) {
    console.error("Test email error:", {
      message: error.message,
      code: error.code,
      response: error.response,
    });
    res.status(500).json({ message: "Failed to send test email", error: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));