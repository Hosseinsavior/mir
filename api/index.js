require('dotenv').config(); // اضافه کردن این خط برای پشتیبانی احتمالی از dotenv (اختیاری، فعلاً کامنت کن مگر اینکه نصبش کنی)

const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const sharp = require('sharp');
const si = require('systeminformation');
const ffmpeg = require('ffmpeg-static');
const FormData = require('form-data');

const botToken = process.env.BOT_TOKEN;
const botOwner = process.env.BOT_OWNER; // مطمئن شو این متغیر توی Vercel تنظیم شده
const streamtapeApiUsername = process.env.STREAMTAPE_API_USERNAME;
const streamtapeApiPass = process.env.STREAMTAPE_API_PASS;
const updatesChannel = process.env.UPDATES_CHANNEL; // تنظیم کن توی Vercel
const logChannel = process.env.LOG_CHANNEL; // تنظیم کن توی Vercel

let db;
let bot;

async function connectMongoDB() {
  try {
    console.log('MONGODB_URI:', process.env.MONGODB_URI); // لاگ برای دیباگ
    const client = await MongoClient.connect(process.env.MONGODB_URI, { useUnifiedTopology: true });
    db = client.db('video_merge_bot');
    console.log('Connected to MongoDB');
    if (botOwner) {
      const botInstance = new Telegraf(botToken);
      await botInstance.telegram.sendMessage(botOwner, 'Successfully connected to MongoDB!')
        .catch((err) => console.error('Failed to notify owner:', err));
    }
  } catch (err) {
    console.error('MongoDB connection error:', err);
    if (botOwner) {
      const botInstance = new Telegraf(botToken);
      await botInstance.telegram.sendMessage(botOwner, `MongoDB connection failed: ${err.message}`)
        .catch((e) => console.error('Failed to notify owner:', e));
    }
    throw err;
  }
}

async function startBot() {
  try {
    await connectMongoDB();
    bot = new Telegraf(botToken);

    // تنظیمات اولیه ربات
    bot.start((ctx) => {
      console.log('Bot started by:', ctx.from.username);
      ctx.reply('Welcome! Use /settings to configure the bot.');
    });

    bot.command('settings', (ctx) => {
      console.log('Settings command by:', ctx.from.username);
      ctx.reply('Settings menu:', Markup.keyboard([
        ['Set Owner', 'Set Updates Channel'],
        ['Set Log Channel', 'View Settings']
      ]).resize());
    });

    bot.on('text', async (ctx) => {
      const message = ctx.message.text;
      console.log('Received text:', message);
      ctx.reply('Echo: ' + message);
    });

    bot.on('video', async (ctx) => {
      const video = ctx.message.video;
      console.log('Received video:', video.file_id);
      ctx.reply('Video received! Processing...');
    });

    // Webhook تنظیم
    const webhookUrl = `https://${process.env.VERCEL_URL}/api`; // مطمئن شو VERCEL_URL توی Vercel تنظیم شده
    await bot.telegram.setWebhook(webhookUrl);
    console.log('Webhook set to:', webhookUrl);

    // استارت ربات
    bot.launch();
    console.log('Bot is running...');

    // لاگ سیستم (اختیاری)
    const systemInfo = await si.get({
      cpu: 'manufacturer, brand, speed',
      mem: 'total',
      os: 'platform, release'
    });
    console.log('System Info:', systemInfo);

  } catch (err) {
    console.error('Bot startup error:', err);
    if (botOwner) {
      const botInstance = new Telegraf(botToken);
      await botInstance.telegram.sendMessage(botOwner, `Bot startup failed: ${err.message}`)
        .catch((e) => console.error('Failed to notify owner:', e));
    }
    process.exit(1); // خروج با خطا
  }
}

startBot();

// گر ace کردن برنامه
process.on('SIGTERM', () => bot.stop('SIGTERM'));
process.on('SIGINT', () => bot.stop('SIGINT'));