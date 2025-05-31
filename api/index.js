require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const sharp = require('sharp');
const si = require('systeminformation');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');

// متغیرهای محیطی
const botToken = '5115356918:AAFH3T-1f2x4ZdikRQnNoOXXgonLUlwryAQ';
const botOwner = process.env.BOT_OWNER || '5059280908';
const updatesChannel = process.env.UPDATES_CHANNEL || '';
const logChannel = process.env.LOG_CHANNEL || '';
const downPath = process.env.DOWN_PATH || './downloads';
const timeGap = parseInt(process.env.TIME_GAP) || 5;
const maxVideos = parseInt(process.env.MAX_VIDEOS) || 5;
const streamtapeUsername = process.env.STREAMTAPE_API_USERNAME || 'e570d9deef272a462305';
const streamtapePass = process.env.STREAMTAPE_API_PASS || '3w8wLp7ZPludYbW';
const mongoUri = 'mongodb+srv://saviorsann:TDzeYsGIJwvVkRy4@cluster0.9otjsyr.mongodb.net/video_merge_bot?retryWrites=true&w=majority';
if (!mongoUri) {
  console.error('MONGODB_URI is not defined');
  if (botOwner) {
    const bot = new Telegraf(botToken);
    bot.telegram.sendMessage(botOwner, 'Error: MONGODB_URI is not defined. Please set it in Vercel environment variables.')
      .catch((err) => console.error('Failed to notify owner:', err));
  }
  throw new Error('MONGODB_URI is not defined');
}
const broadcastAsCopy = process.env.BROADCAST_AS_COPY === 'true';
const captionTemplate = "Video Merged by @{botUsername}\n\nMade by @Savior_128";

// MongoDB اتصال
let db;
async function connectMongoDB() {
  try {
    console.log('MONGODB_URI value:', mongoUri);
    console.log('Attempting to connect to MongoDB...');
    const client = await MongoClient.connect(mongoUri, { useUnifiedTopology: true });
    db = client.db('video_merge_bot');
    console.log('Connected to MongoDB successfully');
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

// ربات
const bot = new Telegraf(botToken);

// دیتابیس و صف‌ها
const QueueDB = {};
const ReplyDB = {};
const FormatDB = {};
const TimeGaps = {};
const broadcastIds = {};
const BROADCAST_LOG_FILE = 'broadcast.txt';

// ایجاد پوشه دانلود
async function ensureDir(userId) {
  const dir = path.join(downPath, userId.toString());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// دکمه‌های اینلاین ساده
async function createReplyMarkup() {
  try {
    return Markup.inlineKeyboard([
      [Markup.button.url('Developer - @Savior_128', 'https://t.me/Savior_128')],
      [
        Markup.button.url('Support Group', 'https://t.me/Savior_128'),
        Markup.button.url('Bots Channel', 'https://t.me/Discovery_Updates'),
      ],
    ]);
  } catch (error) {
    console.error('Create reply markup error:', error);
    return null;
  }
}

// افزودن کاربر به دیتابیس
async function addUserToDatabase(ctx) {
  try {
    if (!db) {
      console.error('Database not connected in addUserToDatabase');
      await ctx.reply(
        'Sorry, the bot cannot connect to the database right now. Please try again later or contact the [Support Group](https://t.me/Savior_128).',
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
      return;
    }
    const userId = ctx.from.id;
    console.log(`Checking if user ${userId} exists in the database...`);
    const userExists = await db.collection('users').findOne({ id: userId });
    
    if (!userExists) {
      console.log(`User ${userId} does not exist. Adding to database...`);
      await db.collection('users').insertOne({
        id: userId,
        join_date: new Date().toISOString().split('T')[0],
        upload_as_doc: false,
        thumbnail: null,
        generate_ss: false,
        generate_sample_video: false,
        username: ctx.from.username || 'unknown',
        updated_at: new Date(),
      });
      console.log(`User ${userId} added to database successfully.`);

      if (logChannel) {
        const botUsername = (await ctx.telegram.getMe()).username;
        await ctx.telegram.sendMessage(
          logChannel,
          `#NEW_USER: \n\nNew User [${ctx.from.first_name}](tg://user?id=${userId}) started @${botUsername} !!`,
          { parse_mode: 'Markdown' }
        );
        console.log(`Sent new user notification to log channel for user ${userId}.`);
      }
    } else {
      console.log(`User ${userId} already exists in the database.`);
    }
  } catch (error) {
    console.error('Add user error:', error);
    await ctx.reply(
      'An error occurred while adding you to the database. Please try again later or contact the [Support Group](https://t.me/Savior_128).',
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  }
}

// بررسی عضویت در کانال
async function forceSub(ctx) {
  if (!updatesChannel) return 200;
  const chatId = updatesChannel.startsWith('-100') ? parseInt(updatesChannel) : updatesChannel;

  try {
    const user = await ctx.telegram.getChatMember(chatId, ctx.from.id);
    if (user.status === 'kicked') {
      await ctx.reply(
        'Sorry Sir, You are Banned to use me. Contact my [Support Group](https://t.me/Savior_128).',
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
      return 400;
    }
    if (['member', 'administrator', 'creator'].includes(user.status)) return 200;

    const inviteLink = await ctx.telegram.exportChatInviteLink(chatId);
    await ctx.reply(
      '**Please Join My Updates Channel to use this Bot!**\n\nDue to Overload, Only Channel Subscribers can use the Bot!',
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url('🤖 Join Updates Channel', inviteLink)],
          [Markup.button.callback('🔄 Refresh 🔄', 'refreshFsub')],
        ]),
        parse_mode: 'Markdown',
      }
    );
    return 400;
  } catch (error) {
    if (error.response?.error_code === 429) {
      await new Promise((resolve) => setTimeout(resolve, error.response.parameters.retry_after * 1000));
      return forceSub(ctx);
    }
    console.error('ForceSub error:', error);
    await ctx.reply(
      `Something went wrong: ${error.message}\nContact my [Support Group](https://t.me/Savior_128).`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
    return 400;
  }
}

// بررسی فاصله زمانی
async function checkTimeGap(userId) {
  const currentTime = Date.now() / 1000;
  const userIdStr = userId.toString();
  if (TimeGaps[userIdStr]) {
    const previousTime = TimeGaps[userIdStr];
    const elapsedTime = currentTime - previousTime;
    if (elapsedTime < timeGap) {
      return { isInGap: true, sleepTime: Math.round(timeGap - elapsedTime) };
    } else {
      delete TimeGaps[userIdStr];
    }
  }
  TimeGaps[userIdStr] = currentTime;
  return { isInGap: false, sleepTime: null };
}

// دیتابیس: تنظیمات
async function getUploadAsDoc(userId) {
  if (!db) throw new Error('Database not connected');
  const user = await db.collection('users').findOne({ id: userId });
  return user?.upload_as_doc || false;
}

async function setUploadAsDoc(userId, uploadAsDoc) {
  if (!db) throw new Error('Database not connected');
  await db.collection('users').updateOne(
    { id: userId },
    { $set: { upload_as_doc: uploadAsDoc, updated_at: new Date() } }
  );
}

async function getGenerateSampleVideo(userId) {
  if (!db) throw new Error('Database not connected');
  const user = await db.collection('users').findOne({ id: userId });
  return user?.generate_sample_video || false;
}

async function setGenerateSampleVideo(userId, generateSampleVideo) {
  if (!db) throw new Error('Database not connected');
  await db.collection('users').updateOne(
    { id: userId },
    { $set: { generate_sample_video: generateSampleVideo, updated_at: new Date() } }
  );
}

async function getGenerateSs(userId) {
  if (!db) throw new Error('Database not connected');
  const user = await db.collection('users').findOne({ id: userId });
  return user?.generate_ss || false;
}

async function setGenerateSs(userId, generateSs) {
  if (!db) throw new Error('Database not connected');
  await db.collection('users').updateOne(
    { id: userId },
    { $set: { generate_ss: generateSs, updated_at: new Date() } }
  );
}

async function setThumbnail(userId, fileId) {
  if (!db) throw new Error('Database not connected');
  await db.collection('users').updateOne(
    { id: userId },
    { $set: { thumbnail: fileId, updated_at: new Date() } }
  );
}

async function getThumbnail(userId) {
  if (!db) throw new Error('Database not connected');
  const user = await db.collection('users').findOne({ id: userId });
  return user?.thumbnail || null;
}

async function deleteUser(userId) {
  if (!db) throw new Error('Database not connected');
  await db.collection('users').deleteOne({ id: userId });
}

async function getAllUsers() {
  if (!db) throw new Error('Database not connected');
  const users = await db.collection('users').find({}).toArray();
  return users;
}

async function totalUsersCount() {
  if (!db) throw new Error('Database not connected');
  return await db.collection('users').countDocuments({});
}

// Streamtape
async function uploadToStreamtape(file, ctx, fileSize) {
  try {
    const mainApi = `https://api.streamtape.com/file/ul?login=${streamtapeUsername}&key=${streamtapePass}`;
    const hitApi = await axios.get(mainApi);
    const jsonData = hitApi.data;

    if (jsonData.result?.url) {
      const formData = new FormData();
      formData.append('file1', require('fs').createReadStream(file));
      const response = await axios.post(jsonData.result.url, formData, {
        headers: formData.getHeaders(),
      });
      const data = response.data;

      if (data.result?.url) {
        const downloadLink = data.result.url;
        const filename = path.basename(file).replace('_', ' ');
        const textEdit = `File Uploaded to Streamtape!\n\n` +
          `**File Name:** \`${filename}\`\n` +
          `**Size:** \`${humanbytes(fileSize)}\`\n` +
          `**Link:** \`${downloadLink}\``;
        try {
          await ctx.editMessageText(textEdit, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: Markup.inlineKeyboard([[Markup.button.url('Open Link', downloadLink)]]),
          });
        } catch (editError) {
          await ctx.reply(textEdit, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: Markup.inlineKeyboard([[Markup.button.url('Open Link', downloadLink)]]),
          });
        }
      } else {
        throw new Error('Failed to retrieve download link from Streamtape.');
      }
    } else {
      throw new Error('Failed to authenticate with Streamtape API.');
    }
  } catch (error) {
    console.error('Streamtape error:', error);
    try {
      await ctx.reply(
        'Sorry, Something went wrong!\n\nCan\'t Upload to Streamtape. You can report at [Support Group](https://t.me/Savior_128).',
        { parse_mode: 'Markdown' }
      );
    } catch (replyError) {
      console.error('Reply error:', replyError);
    }
  }
}

// توابع FFmpeg با spawn
async function mergeVideo(inputFile, userId, ctx, format) {
  const outputVid = path.join(downPath, userId.toString(), `[@Savior_128]_Merged.${format.toLowerCase()}`);
  const command = [
    'ffmpeg',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    inputFile,
    '-c',
    'copy',
    outputVid,
  ];

  console.log(`DEBUG: Running FFmpeg command: ${command.join(' ')}`);

  return new Promise((resolve) => {
    let process;
    try {
      process = spawn('ffmpeg', command.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`DEBUG: FFmpeg process spawned, PID: ${process.pid}`);
    } catch (error) {
      console.error('DEBUG: FFmpeg spawn error:', error.stack);
      ctx.reply('Unable to execute FFmpeg command! Please contact support.');
      resolve(null);
      return;
    }

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log('DEBUG: FFmpeg stdout:', data.toString());
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('DEBUG: FFmpeg stderr:', data.toString());
    });

    process.on('error', (error) => {
      console.error('DEBUG: FFmpeg process error:', error.stack);
      ctx.reply(`FFmpeg error: ${error.message}`);
      resolve(null);
    });

    const mergeTimeout = 120000; // 120 ثانیه
    const timeoutId = setTimeout(() => {
      process.kill('SIGKILL');
      console.error('DEBUG: FFmpeg process timed out');
      ctx.reply('FFmpeg process timed out. Please try again with smaller videos.');
      resolve(null);
    }, mergeTimeout);

    process.on('close', async (code) => {
      clearTimeout(timeoutId);
      console.log(`DEBUG: FFmpeg process exited with code ${code}`);
      if (code === 0 && (await fs.access(outputVid).then(() => true).catch(() => false))) {
        console.log(`DEBUG: Merged video created at ${outputVid}`);
        resolve(outputVid);
      } else {
        console.log('DEBUG: Merged video file does not exist.');
        await ctx.reply(`Failed to merge videos! FFmpeg exited with code ${code}\nError: ${stderr}`);
        resolve(null);
      }
    });

    ctx.editMessageText('Merging Video Now ...\n\nPlease Keep Patience ...').catch((err) => {
      console.error('DEBUG: Edit message error:', err.stack);
      ctx.reply('Merging Video Now ...\n\nPlease Keep Patience ...');
    });
  });
}

async function cutSmallVideo(videoFile, outputDirectory, startTime, endTime, format) {
  const outputFileName = path.join(outputDirectory, `${Date.now()}.${format.toLowerCase()}`);
  const command = [
    'ffmpeg',
    '-i',
    videoFile,
    '-ss',
    startTime.toString(),
    '-to',
    endTime.toString(),
    '-async',
    '1',
    '-strict',
    '-2',
    outputFileName,
  ];

  console.log(`DEBUG: Running FFmpeg command for cut: ${command.join(' ')}`);

  return new Promise((resolve) => {
    const process = spawn('ffmpeg', command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log('DEBUG: FFmpeg stdout (cut):', data.toString());
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('DEBUG: FFmpeg stderr (cut):', data.toString());
    });

    process.on('error', (error) => {
      console.error('DEBUG: FFmpeg process error (cut):', error.stack);
      resolve(null);
    });

    process.on('close', async (code) => {
      console.log(`DEBUG: FFmpeg process (cut) exited with code ${code}`);
      if (code === 0 && (await fs.access(outputFileName).then(() => true).catch(() => false))) {
        resolve(outputFileName);
      } else {
        console.log('DEBUG: Cut video file does not exist.');
        resolve(null);
      }
    });
  });
}

async function generateScreenshots(videoFile, outputDirectory, noOfPhotos, duration) {
  if (duration <= 0 || noOfPhotos <= 0) {
    console.log('DEBUG: Invalid duration or number of photos.');
    return [];
  }

  const images = [];
  const ttlStep = duration / noOfPhotos;
  let currentTtl = ttlStep;

  for (let i = 0; i < noOfPhotos; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const videoThumbnail = path.join(outputDirectory, `${Date.now()}.jpg`);
    const command = [
      'ffmpeg',
      '-ss',
      Math.round(currentTtl).toString(),
      '-i',
      videoFile,
      '-vframes',
      '1',
      videoThumbnail,
    ];

    console.log(`DEBUG: Running FFmpeg command for screenshot: ${command.join(' ')}`);

    const process = spawn('ffmpeg', command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log('DEBUG: FFmpeg stdout (screenshot):', data.toString());
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('DEBUG: FFmpeg stderr (screenshot):', data.toString());
    });

    process.on('error', (error) => {
      console.error('DEBUG: FFmpeg process error (screenshot):', error.stack);
    });

    process.on('close', async (code) => {
      console.log(`DEBUG: FFmpeg process (screenshot) exited with code ${code}`);
      if (code === 0 && (await fs.access(videoThumbnail).then(() => true).catch(() => false))) {
        images.push(videoThumbnail);
      }
    });

    currentTtl += ttlStep;
  }
  return images;
}

async function generateThumbnail(filePath, userId, duration) {
  try {
    const thumbPath = path.join(downPath, userId.toString(), 'thumbnail.jpg');
    const ttl = Math.floor(Math.random() * duration);
    const command = [
      'ffmpeg',
      '-i',
      filePath,
      '-ss',
      ttl.toString(),
      '-vframes',
      '1',
      thumbPath,
    ];

    console.log(`DEBUG: Running FFmpeg command for thumbnail: ${command.join(' ')}`);

    return new Promise((resolve) => {
      const process = spawn('ffmpeg', command.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log('DEBUG: FFmpeg stdout (thumbnail):', data.toString());
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log('DEBUG: FFmpeg stderr (thumbnail):', data.toString());
      });

      process.on('error', (error) => {
        console.error('DEBUG: FFmpeg process error (thumbnail):', error.stack);
        resolve(null);
      });

      process.on('close', async (code) => {
        console.log(`DEBUG: FFmpeg process (thumbnail) exited with code ${code}`);
        if (code === 0 && (await fs.access(thumbPath).then(() => true).catch(() => false))) {
          await sharp(thumbPath).jpeg().toFile(thumbPath);
          resolve(thumbPath);
        } else {
          console.log('DEBUG: Thumbnail file does not exist.');
          resolve(null);
        }
      });
    });
  } catch (error) {
    console.error('Thumbnail error:', error);
    return null;
  }
}

// استخراج متادیتا ویدیو
async function getVideoMetadata(filePath) {
  const command = [
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=width,height',
    '-of',
    'json',
    filePath,
  ];

  console.log(`DEBUG: Running ffprobe command: ${command.join(' ')}`);

  return new Promise((resolve) => {
    const process = spawn('ffprobe', command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log('DEBUG: ffprobe stdout:', data.toString());
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log('DEBUG: ffprobe stderr:', data.toString());
    });

    process.on('error', (error) => {
      console.error('DEBUG: ffprobe process error:', error.stack);
      resolve({ duration: 1, width: 100, height: 100 });
    });

    process.on('close', (code) => {
      console.log(`DEBUG: ffprobe process exited with code ${code}`);
      if (code === 0) {
        try {
          const data = JSON.parse(stdout);
          resolve({
            duration: Math.round(parseFloat(data.format.duration)),
            width: data.streams[0].width || 100,
            height: data.streams[0].height || 100,
          });
        } catch (error) {
          console.error('DEBUG: ffprobe JSON parse error:', error.stack);
          resolve({ duration: 1, width: 100, height: 100 });
        }
      } else {
        console.log('DEBUG: ffprobe failed.');
        resolve({ duration: 1, width: 100, height: 100 });
      }
    });
  });
}

// آپلود ویدیو
async function uploadVideo(ctx, filePath, width, height, duration, thumbnail, fileSize, startTime) {
  try {
    console.log(`DEBUG: Starting upload for file: ${filePath}`);
    const isUploadAsDoc = await getUploadAsDoc(ctx.from.id);
    const botUsername = (await ctx.telegram.getMe()).username;
    const fileName = path.basename(filePath);
    const caption = captionTemplate.replace('{botUsername}', `@${botUsername}`);
    let sent;

    if (!isUploadAsDoc) {
      sent = await ctx.telegram.sendVideo(
        ctx.chat.id,
        { source: filePath },
        {
          width,
          height,
          duration,
          thumb: thumbnail,
          caption,
          parse_mode: 'Markdown',
          reply_markup: await createReplyMarkup(),
          progress: (current, total) => progressForTelegraf(current, total, 'Uploading Video ...', ctx, startTime),
        }
      );
    } else {
      sent = await ctx.telegram.sendDocument(
        ctx.chat.id,
        { source: filePath },
        {
          thumb: thumbnail,
          caption,
          parse_mode: 'Markdown',
          reply_markup: await createReplyMarkup(),
          progress: (current, total) => progressForTelegraf(current, total, 'Uploading Video ...', ctx, startTime),
        }
      );
    }

    console.log(`DEBUG: Upload completed, message_id: ${sent.message_id}`);

    await new Promise((resolve) => setTimeout(resolve, timeGap * 1000));
    if (logChannel) {
      const forwarded = await sent.copy(logChannel);
      await ctx.telegram.sendMessage(
        logChannel,
        `**User:** [${ctx.from.first_name}](tg://user?id=${ctx.from.id})\n**Username:** @${ctx.from.username || 'None'}\n**UserID:** \`${ctx.from.id}\``,
        { reply_to_message_id: forwarded.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }

    await ctx.reply('Video uploaded successfully!');
  } catch (error) {
    console.error('DEBUG: Upload error:', error.stack);
    try {
      await ctx.reply(`Failed to upload video!\nError: ${error.message}`);
    } catch (editError) {
      await ctx.reply(`Failed to upload video!\nError: ${error.message}`);
    }
  }
}

// پیشرفت
async function progressForTelegraf(current, total, udType, ctx, start) {
  if (current >= total) return true;

  const now = Date.now() / 1000;
  const diff = now - start;

  if (Math.round(diff % 10) === 0) {
    const percentage = (current / total) * 100;
    const speed = diff > 0 ? current / diff : 0;
    const elapsedTime = Math.round(diff) * 1000;
    const timeToCompletion = speed > 0 ? Math.round(((total - current) / speed) * 1000) : 0;
    const estimatedTotalTime = elapsedTime + timeToCompletion;

    const progressMessage = `
Percentage : ${percentage.toFixed(2)}%
Done: ${humanbytes(current)}
Total: ${humanbytes(total)}
Speed: ${humanbytes(speed)}/s
ETA: ${timeFormatter(estimatedTotalTime) || '0 s'}
    `;

    const progressBar = '[' +
      '●'.repeat(Math.floor(percentage / 5)) +
      '○'.repeat(20 - Math.floor(percentage / 5)) +
      ']';

    try {
      await ctx.editMessageText(
        `**${udType}**\n\n${progressBar}\n${progressMessage}`,
        { parse_mode: 'Markdown' }
      );
      return true;
    } catch (error) {
      console.error('Progress update error:', error);
      return false;
    }
  }
  return true;
}

function humanbytes(size) {
  if (size === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = 0;
  while (size > 1024 && n < units.length - 1) {
    size /= 1024;
    n++;
  }
  return `${size.toFixed(2)} ${units[n]}`;
}

function timeFormatter(milliseconds) {
  if (!milliseconds) return '';
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours % 24) parts.push(`${hours % 24}h`);
  if (minutes % 60) parts.push(`${minutes % 60}m`);
  if (seconds % 60) parts.push(`${seconds % 60}s`);
  if (milliseconds % 1000) parts.push(`${milliseconds % 1000}ms`);
  return parts.join(', ');
}

function formatTimespan(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${secs}s`;
}

// دانلود فایل
async function downloadFile(ctx, fileId, filePath) {
  try {
    const file = await ctx.telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const response = await axios.get(url, { responseType: 'stream' });
    const writer = response.data.pipe(require('fs').createWriteStream(filePath));
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Download file error:', error);
    throw error;
  }
}

// حذف همه فایل‌ها
async function deleteAll(root) {
  try {
    if (await fs.access(root).then(() => true).catch(() => false)) {
      await fs.rm(root, { recursive: true, force: true });
      return true;
    }
    console.log(`DEBUG: Folder '${root}' does not exist.`);
    return false;
  } catch (error) {
    console.error(`DEBUG: Error deleting folder '${root}':`, error);
    return false;
  }
}

// دستور /start
bot.start(async (ctx) => {
  await addUserToDatabase(ctx);
  if ((await forceSub(ctx)) !== 200) return;
  await ctx.reply(
    `Hi Unkil, I am Video Merge Bot!\nI can Merge Multiple Videos in One Video. Video Formats should be same.\n\nAvailable Commands:\n/start - Start the bot\n/add - Add a video to queue\n/merge - Merge videos\n/clear - Clear queue\n/settings - Open settings\n\nMade by @Savior_128`,
    { reply_markup: await createReplyMarkup() }
  );
});

// مدیریت ویدیوها با ارسال ویدیو
bot.on('video', async (ctx) => {
  await addUserToDatabase(ctx);
  if ((await forceSub(ctx)) !== 200) return;
  const file = ctx.message.video;
  const fileName = file.file_name || 'video.mp4';
  const extension = fileName.split('.').pop().toLowerCase();

  console.log('DEBUG: Processing video from user:', ctx.from.id, 'File:', fileName);

  if (!['mp4', 'mkv', 'webm'].includes(extension)) {
    return ctx.reply('Only MP4, MKV, or WEBM videos are allowed!', { reply_to_message_id: ctx.message.message_id });
  }

  if (!FormatDB[ctx.from.id]) FormatDB[ctx.from.id] = extension;
  if (FormatDB[ctx.from.id] !== extension) {
    return ctx.reply(`Please send only ${FormatDB[ctx.from.id].toUpperCase()} videos!`, { reply_to_message_id: ctx.message.message_id });
  }

  const { isInGap, sleepTime } = await checkTimeGap(ctx.from.id);
  if (isInGap) {
    return ctx.reply(`No flooding! Wait ${sleepTime}s before sending another video.`, { reply_to_message_id: ctx.message.message_id });
  }

  if (!QueueDB[ctx.from.id]) QueueDB[ctx.from.id] = [];
  if (QueueDB[ctx.from.id].length >= maxVideos) {
    return ctx.reply(`Max ${maxVideos} videos allowed! Use /merge to proceed.`);
  }

  QueueDB[ctx.from.id].push(ctx.message.message_id);
  console.log('DEBUG: Updated QueueDB:', JSON.stringify(QueueDB[ctx.from.id]));
  await ctx.reply(`Video added to queue! Total videos: ${QueueDB[ctx.from.id].length}\nUse /merge to combine or /clear to reset.`);
});

// دستور /merge
bot.command('merge', async (ctx) => {
  const userId = ctx.from.id;
  if (!QueueDB[userId] || QueueDB[userId].length < 2) {
    return ctx.reply('Need at least 2 videos to merge! Use /add to add more.');
  }

  console.log(`DEBUG: Merge command started for user ${userId}`);

  let preparingMessage;
  try {
    preparingMessage = await ctx.reply('Preparing to merge videos...');
    console.log(`DEBUG: Preparing message sent, message_id: ${preparingMessage.message_id}`);
  } catch (error) {
    console.error(`DEBUG: Error sending preparing message:`, error.stack);
    return ctx.reply('Error starting merge process. Please try again.');
  }

  const userDir = await ensureDir(userId);
  const inputFile = path.join(userDir, 'input.txt');
  const videoPaths = [];

  console.log(`DEBUG: Starting merge for user ${userId}, Queue: ${JSON.stringify(QueueDB[userId])}`);
  console.log(`DEBUG: User directory: ${userDir}`);

  for (const messageId of QueueDB[userId].sort()) {
    try {
      console.log(`DEBUG: Processing message_id ${messageId}`);
      const fileLink = await ctx.telegram.getFileLink(messageId);
      console.log(`DEBUG: File link for ${messageId}: ${fileLink.href}`);
      const filePath = path.join(userDir, `${messageId}.${FormatDB[userId]}`);
      console.log(`DEBUG: Saving to file path: ${filePath}`);

      let downloadingMessage;
      try {
        downloadingMessage = await ctx.reply(`Downloading ${messageId}...`);
        console.log(`DEBUG: Downloading message sent, message_id: ${downloadingMessage.message_id}`);
      } catch (error) {
        console.error(`DEBUG: Error sending downloading message:`, error.stack);
      }

      // اضافه کردن Timeout برای دانلود
      const downloadTimeout = 60000; // 60 ثانیه
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), downloadTimeout);

      try {
        const response = await axios({
          method: 'get',
          url: fileLink.href,
          responseType: 'stream',
          signal: controller.signal,
          onDownloadProgress: (progressEvent) => {
            if (progressEvent.total) {
              console.log(`DEBUG: Download progress for ${messageId}: ${progressEvent.loaded}/${progressEvent.total}`);
            }
          },
        });

        clearTimeout(timeoutId);

        const writer = response.data.pipe(require('fs').createWriteStream(filePath));
        await new Promise((resolve, reject) => {
          writer.on('finish', () => {
            console.log(`DEBUG: Download completed for ${messageId}`);
            resolve();
          });
          writer.on('error', (err) => {
            console.error(`DEBUG: Download stream error for ${messageId}:`, err.stack);
            reject(err);
          });
        });
        videoPaths.push(`file '${filePath}'`);
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          console.error(`DEBUG: Download timeout for ${messageId}`);
          throw new Error(`Download timeout for file ${messageId}`);
        }
        throw error;
      }
    } catch (error) {
      console.error(`DEBUG: Download error for ${messageId}:`, error.stack);
      QueueDB[userId] = QueueDB[userId].filter((id) => id !== messageId);
      await ctx.reply(`File ${messageId} skipped due to error: ${error.message}`);
    }
  }

  console.log(`DEBUG: Total valid video paths: ${videoPaths.length}`);
  if (videoPaths.length < 2) {
    await ctx.reply('Not enough valid videos to merge!');
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }

  try {
    await fs.writeFile(inputFile, videoPaths.join('\n'));
    console.log(`DEBUG: Input file created at ${inputFile} with content: ${videoPaths.join('\n')}`);
  } catch (error) {
    console.error(`DEBUG: Error writing input file:`, error.stack);
    await ctx.reply('Error preparing videos for merge.');
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }

  console.log(`DEBUG: Starting FFmpeg merge process...`);
  const mergedVidPath = await mergeVideo(inputFile, userId, ctx, FormatDB[userId]);
  if (!mergedVidPath) {
    console.log(`DEBUG: Merge failed for user ${userId}`);
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }

  console.log(`DEBUG: Merge successful, output path: ${mergedVidPath}`);
  let fileSize;
  try {
    fileSize = (await fs.stat(mergedVidPath)).size;
  } catch (error) {
    console.error(`DEBUG: Error getting file size:`, error.stack);
    await ctx.reply('Error processing merged video.');
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }

  if (fileSize > 2097152000) {
    await ctx.reply(`File too large (${humanbytes(fileSize)}). Uploading to Streamtape...`);
    await uploadToStreamtape(mergedVidPath, ctx, fileSize);
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }

  await ctx.reply('Extracting video data...');
  let metadata;
  try {
    metadata = await getVideoMetadata(mergedVidPath);
  } catch (error) {
    console.error(`DEBUG: Error extracting metadata:`, error.stack);
    await ctx.reply('Error extracting video metadata.');
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }
  const { duration, width, height } = metadata;

  let thumbnail = await getThumbnail(userId);
  if (thumbnail) {
    const thumbPath = path.join(downPath, userId.toString(), 'thumbnail.jpg');
    try {
      await downloadFile(ctx, thumbnail, thumbPath);
      await sharp(thumbPath).resize(width, height).jpeg().toFile(thumbPath);
      thumbnail = thumbPath;
    } catch (error) {
      console.error(`DEBUG: Error processing thumbnail:`, error.stack);
      thumbnail = null;
    }
  }
  if (!thumbnail) {
    try {
      thumbnail = await generateThumbnail(mergedVidPath, userId, duration);
    } catch (error) {
      console.error(`DEBUG: Error generating thumbnail:`, error.stack);
    }
  }

  const shouldGenerateSs = await getGenerateSs(userId);
  const shouldGenerateSample = await getGenerateSampleVideo(userId);
  if (shouldGenerateSs) {
    try {
      const screenshots = await generateScreenshots(mergedVidPath, path.join(downPath, userId.toString()), 4, duration);
      if (screenshots.length > 0) {
        await ctx.replyWithMediaGroup(
          screenshots.map((s) => ({ type: 'photo', media: { source: s } }))
        );
      }
    } catch (error) {
      console.error(`DEBUG: Error generating screenshots:`, error.stack);
    }
  }
  if (shouldGenerateSample) {
    try {
      const samplePath = await cutSmallVideo(
        mergedVidPath,
        path.join(downPath, userId.toString()),
        0,
        Math.min(30, duration),
        FormatDB[userId]
      );
      if (samplePath) {
        await ctx.replyWithVideo({ source: samplePath }, { caption: 'Sample Video' });
      }
    } catch (error) {
      console.error(`DEBUG: Error generating sample video:`, error.stack);
    }
  }

  const startTime = Date.now() / 1000;
  try {
    await uploadVideo(ctx, mergedVidPath, width, height, duration, thumbnail, fileSize, startTime);
  } catch (error) {
    console.error(`DEBUG: Error uploading video:`, error.stack);
    await ctx.reply('Error uploading the final video.');
  }

  await deleteAll(path.join(downPath, userId.toString()));
  delete QueueDB[userId];
  delete FormatDB[userId];
});

// دستور /clear
bot.command('clear', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.reply('Cancelling process...');
  await deleteAll(path.join(downPath, userId.toString()));
  delete QueueDB[userId];
  delete FormatDB[userId];
  await ctx.reply('Queue cleared successfully!');
});

// مدیریت عکس (تامبنیل)
bot.on('photo', async (ctx) => {
  await addUserToDatabase(ctx);
  if ((await forceSub(ctx)) !== 200) return;
  const editable = await ctx.reply('Saving thumbnail...', { reply_to_message_id: ctx.message.message_id });
  try {
    await setThumbnail(ctx.from.id, ctx.message.photo[ctx.message.photo.length - 1].file_id);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      editable.message_id,
      null,
      'Thumbnail saved!',
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('Show Thumbnail', 'showThumbnail')],
          [Markup.button.callback('Delete Thumbnail', 'deleteThumbnail')],
        ]),
      }
    );
  } catch (error) {
    console.error('Thumbnail save error:', error);
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        editable.message_id,
        null,
        'Error saving thumbnail.'
      );
    } catch (editError) {
      await ctx.reply('Error saving thumbnail.');
    }
  }
});

// دستور /settings
bot.command('settings', async (ctx) => {
  await addUserToDatabase(ctx);
  if ((await forceSub(ctx)) !== 200) return;
  const editable = await ctx.reply('Opening settings...');
  await openSettings(ctx, editable);
});

// دستور /broadcast
bot.command('broadcast', async (ctx) => {
  if (ctx.from.id.toString() !== botOwner || !ctx.message.reply_to_message) return;
  const broadcastMsg = ctx.message.reply_to_message;
  const broadcastId = crypto.randomBytes(3).toString('hex');
  const out = await ctx.reply('Broadcast Started! You will reply with log file when all the users are notified.');
  const startTime = Date.now();
  const totalUsers = await totalUsersCount();
  let done = 0, failed = 0, success = 0;
  broadcastIds[broadcastId] = { total: totalUsers, current: done, failed, success };

  try {
    await fs.writeFile(BROADCAST_LOG_FILE, '');
    const users = await getAllUsers();
    for (const user of users) {
      const userId = user.id;
      const { status, error } = await sendMsg(userId, broadcastMsg);
      if (error) {
        await fs.appendFile(BROADCAST_LOG_FILE, error);
      }
      if (status === 200) {
        success++;
      } else {
        failed++;
        if (status === 400) {
          await deleteUser(userId);
        }
      }
      done++;
      broadcastIds[broadcastId] = { total: totalUsers, current: done, failed, success };
    }

    delete broadcastIds[broadcastId];
    const completedIn = Math.floor((Date.now() - startTime) / 1000);
    await ctx.telegram.deleteMessage(ctx.chat.id, out.message_id);

    if (failed === 0) {
      await ctx.reply(
        `Broadcast completed in \`${completedIn}s\`\n\nTotal users ${totalUsers}.\nTotal done ${done}, ${success} success and ${failed} failed.`,
        { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
      );
    } else {
      await ctx.replyWithDocument(
        { source: BROADCAST_LOG_FILE },
        {
          caption: `Broadcast completed in \`${completedIn}s\`\n\nTotal users ${totalUsers}.\nTotal done ${done}, ${success} success and ${failed} failed.`,
          parse_mode: 'Markdown',
          reply_to_message_id: ctx.message.message_id,
        }
      );
    }
  } catch (error) {
    console.error('Broadcast error:', error);
    await ctx.reply(`Error sending broadcast: ${error.message}`);
  } finally {
    await fs.unlink(BROADCAST_LOG_FILE).catch(() => {});
  }
});

async function sendMsg(userId, message) {
  try {
    if (broadcastAsCopy) {
      await message.copy(userId);
    } else {
      await message.forward(userId);
    }
    return { status: 200, error: null };
  } catch (error) {
    if (error.response?.error_code === 429) {
      await new Promise((resolve) => setTimeout(resolve, error.response.parameters.retry_after * 1000));
      return sendMsg(userId, message);
    }
    if ([403, 400].includes(error.response?.error_code)) {
      return { status: 400, error: `${userId} : ${error.message}\n` };
    }
    return { status: 500, error: `${userId} : ${error.stack}\n` };
  }
}

// دستور /status
bot.command('status', async (ctx) => {
  if (ctx.from.id.toString() !== botOwner) return;
  try {
    const disk = await si.fsSize();
    const cpu = await si.cpu();
    const mem = await si.mem();
    const totalUsers = await totalUsersCount();
    const total = (disk[0].size / 1024 ** 3).toFixed(2);
    const used = (disk[0].used / 1024 ** 3).toFixed(2);
    const free = ((disk[0].size - disk[0].used) / 1024 ** 3).toFixed(2);
    const cpuUsage = cpu.currentLoad;
    const ramUsage = (mem.used / mem.total) * 100;
    await ctx.reply(
      `**Total Disk:** ${total} GB\n**Used:** ${used} GB\n**Free:** ${free} GB\n**CPU Usage:** ${cpuUsage.toFixed(2)}%\n**RAM Usage:** ${ramUsage.toFixed(2)}%\n**Users:** ${totalUsers}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Status error:', error);
    await ctx.reply('Error fetching status.');
  }
});

// دستور /check
bot.command('check', async (ctx) => {
  if (ctx.from.id.toString() !== botOwner || !ctx.message.text.split(' ')[1]) return;
  try {
    const userId = parseInt(ctx.message.text.split(' ')[1]);
    const user = await ctx.telegram.getChat(userId);
    const settings = await db.collection('users').findOne({ id: userId });
    await ctx.reply(
      `**Name:** [${user.first_name}](tg://user?id=${userId})\n**Username:** @${user.username || 'None'}\n**Upload as Doc:** ${settings?.upload_as_doc || false}\n**Generate Screenshots:** ${settings?.generate_ss || false}\n**Generate Sample Video:** ${settings?.generate_sample_video || false}`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (error) {
    console.error('Check error:', error);
    await ctx.reply('Error fetching user details.');
  }
});

// مدیریت Callbackها
bot.action('showThumbnail', async (ctx) => {
  try {
    const fileId = await getThumbnail(ctx.from.id);
    if (fileId) {
      await ctx.answerCbQuery('Sending thumbnail...');
      await ctx.replyWithPhoto(fileId, {
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('Delete Thumbnail', 'deleteThumbnail')]]),
      });
    } else {
      await ctx.answerCbQuery('No thumbnail found!', { show_alert: true });
    }
  } catch (error) {
    console.error('Show thumbnail error:', error);
    await ctx.answerCbQuery('Error fetching thumbnail.');
  }
});

bot.action('deleteThumbnail', async (ctx) => {
  try {
    await setThumbnail(ctx.from.id, null);
    await ctx.editMessageText('Thumbnail deleted!');
  } catch (error) {
    console.error('Delete thumbnail error:', error);
    try {
      await ctx.editMessageText('Error deleting thumbnail.');
    } catch (editError) {
      await ctx.reply('Error deleting thumbnail.');
    }
  }
});

bot.action('refreshFsub', async (ctx) => {
  if ((await forceSub(ctx)) === 200) {
    await ctx.editMessageText(
      `Hi Unkil, I am Video Merge Bot!\nI can Merge Multiple Videos in One Video. Video Formats should be same.\n\nAvailable Commands:\n/start - Start the bot\n/add - Add a video to queue\n/merge - Merge videos\n/clear - Clear queue\n/settings - Open settings\n\nMade by @Savior_128`,
      { reply_markup: await createReplyMarkup() }
    );
  }
});

// توابع کمکی
async function openSettings(ctx, message) {
  try {
    if (!db) throw new Error('Database not connected');
    const uploadAsDoc = await getUploadAsDoc(ctx.from.id);
    const generateSampleVideo = await getGenerateSampleVideo(ctx.from.id);
    const generateSs = await getGenerateSs(ctx.from.id);
    const settingsText = 'Here You Can Change or Configure Your Settings:';
    const markup = Markup.inlineKeyboard([
      [Markup.button.callback(`Upload as ${uploadAsDoc ? 'Document' : 'Video'} ✅`, 'triggerUploadMode')],
      [Markup.button.callback(`Generate Sample Video ${generateSampleVideo ? '✅' : '❌'}`, 'triggerGenSample')],
      [Markup.button.callback(`Generate Screenshots ${generateSs ? '✅' : '❌'}`, 'triggerGenSS')],
      [Markup.button.callback('Show Thumbnail', 'showThumbnail')],
      [Markup.button.callback('Close', 'closeMeh')],
    ]);

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        message.message_id,
        null,
        settingsText,
        { reply_markup: markup }
      );
    } catch (editError) {
      console.error('Edit message error:', editError);
      await ctx.reply(settingsText, { reply_markup: markup });
    }
  } catch (error) {
    console.error('Settings error:', error);
    try {
      await ctx.reply('Error opening settings.');
    } catch (replyError) {
      console.error('Reply error:', replyError);
    }
  }
}

// راه‌اندازی ربات
(async () => {
  try {
    await connectMongoDB();
    const webhookUrl = `https://${process.env.VERCEL_URL}/api`;
    console.log('VERCEL_URL:', process.env.VERCEL_URL);
    if (!process.env.VERCEL_URL) {
      throw new Error('VERCEL_URL is not defined in environment variables');
    }
    console.log('Setting webhook with URL:', webhookUrl);
    await bot.telegram.setWebhook(webhookUrl);
    console.log('Webhook set successfully to:', webhookUrl);
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', webhookInfo);
    if (botOwner) {
      await bot.telegram.sendMessage(
        botOwner,
        `Bot started successfully!\nWebhook set to: ${webhookUrl}\nWebhook Info: ${JSON.stringify(webhookInfo, null, 2)}`
      ).catch((err) => console.error('Failed to notify owner:', err));
    }
    console.log('Bot started');
  } catch (error) {
    console.error('Startup error:', error);
    if (botOwner) {
      await bot.telegram.sendMessage(
        botOwner,
        `Failed to start bot!\nError: ${error.message}`
      ).catch((err) => console.error('Failed to notify owner:', err));
    }
    process.exit(1);
  }
})();

// مدیریت Webhook برای Vercel
module.exports = async (req, res) => {
  try {
    console.log('Received Webhook request body:', req.body);
    if (!req.body || typeof req.body !== 'object') {
      console.error('Invalid request body: Body is empty or not an object');
      return res.status(400).send('Invalid request body');
    }
    if (!req.body.update_id) {
      console.error('Invalid Telegram update: Missing update_id', req.body);
      return res.status(400).send('Invalid Telegram update');
    }
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
};