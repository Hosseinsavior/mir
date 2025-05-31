require('dotenv').config(); // فعلاً کامنت شده چون ترمینال نداری. اگه بعداً نصب کردی، فعال کن

const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const sharp = require('sharp');
const si = require('systeminformation');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);
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
const streamtapeUsername = process.env.STREAMTAPE_API_USERNAME;
const streamtapePass = process.env.STREAMTAPE_API_PASS;
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
const captionTemplate = process.env.CAPTION_TEMPLATE || 'Video Merged by {botUsername}\n\nMade by @Savior_128';

// MongoDB اتصال
let db;
async function connectMongoDB() {
  try {
    console.log('MONGODB_URI value:', mongoUri); // لاگ برای دیباگ
    const client = await MongoClient.connect(mongoUri, { useUnifiedTopology: true });
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

// دکمه‌های اینلاین
async function createReplyMarkup() {
  try {
    return Markup.inlineKeyboard([
      [Markup.button.url('Developer - @Savior_128', 'https://t.me/Savior_128')],
      [
        Markup.button.url('Support Group', 'https://t.me/linux_repo'),
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
    if (!db) throw new Error('Database not connected');
    const userId = ctx.from.id;
    const userExists = await db.collection('users').findOne({ id: userId });
    if (!userExists) {
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
      if (logChannel) {
        const botUsername = (await ctx.telegram.getMe()).username;
        await ctx.telegram.sendMessage(
          logChannel,
          `#NEW_USER: \n\nNew User [${ctx.from.first_name}](tg://user?id=${userId}) started @${botUsername} !!`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  } catch (error) {
    console.error('Add user error:', error);
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
        'Sorry Sir, You are Banned to use me. Contact my [Support Group](https://t.me/linux_repo).',
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
      `Something went wrong: ${error.message}\nContact my [Support Group](https://t.me/linux_repo).`,
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

// دکمه‌های صف
async function makeButtons(ctx, message, dbQueue) {
  const markup = [];
  try {
    const messages = await ctx.telegram.getMessages(message.chat.id, dbQueue[message.from.id] || []);
    for (const msg of messages) {
      const media = msg.video || msg.document;
      if (media) {
        markup.push([Markup.button.callback(media.file_name || 'unnamed_file', `showFileName_${msg.message_id}`)]);
      }
    }
    markup.push([Markup.button.callback('Merge Now', 'mergeNow')]);
    markup.push([Markup.button.callback('Clear Files', 'cancelProcess')]);
  } catch (error) {
    console.error('Make buttons error:', error);
  }
  return markup;
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
        'Sorry, Something went wrong!\n\nCan\'t Upload to Streamtape. You can report at [Support Group](https://t.me/linux_repo).',
        { parse_mode: 'Markdown' }
      );
    } catch (replyError) {
      console.error('Reply error:', replyError);
    }
  }
}

// FFmpeg
async function runFffmpegCommand(command) {
  try {
    const { stdout, stderr } = await execPromise(command.join(' '));
    console.log('FFmpeg stdout:', stdout);
    if (stderr) console.log('FFmpeg stderr:', stderr);
    return { stdout, stderr };
  } catch (error) {
    console.error('FFmpeg error:', error);
    throw error;
  }
}

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

  try {
    await ctx.editMessageText('Merging Video Now ...\n\nPlease Keep Patience ...');
    await runFffmpegCommand(command);
    if (await fs.access(outputVid).then(() => true).catch(() => false)) {
      return outputVid;
    }
    console.log('Merged video file does not exist.');
    return null;
  } catch (error) {
    try {
      await ctx.editMessageText(`An error occurred while merging videos: ${error.message}`);
    } catch (editError) {
      await ctx.reply(`An error occurred while merging videos: ${error.message}`);
    }
    return null;
  }
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

  try {
    await runFffmpegCommand(command);
    if (await fs.access(outputFileName).then(() => true).catch(() => false)) {
      return outputFileName;
    }
    console.log('Cut video file does not exist.');
    return null;
  } catch (error) {
    console.error('Cut video error:', error);
    return null;
  }
}

async function generateScreenshots(videoFile, outputDirectory, noOfPhotos, duration) {
  if (duration <= 0 || noOfPhotos <= 0) {
    console.log('Invalid duration or number of photos.');
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

    try {
      await runFffmpegCommand(command);
      if (await fs.access(videoThumbnail).then(() => true).catch(() => false)) {
        images.push(videoThumbnail);
      }
    } catch (error) {
      console.error('Screenshot error:', error);
    }
    currentTtl += ttlStep;
  }
  return images;
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

    const progressBar = '[' +
      '●'.repeat(Math.floor(percentage / 5)) +
      '○'.repeat(20 - Math.floor(percentage / 5)) +
      ']';

    const progressMessage = `Percentage: ${percentage.toFixed(2)}%\n` +
      `Done: ${humanbytes(current)}\n` +
      `Total: ${humanbytes(total)}\n` +
      `Speed: ${humanbytes(speed)}/s\n` +
      `ETA: ${timeFormatter(estimatedTotalTime) || '0 s'}`;

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

// آپلود ویدیو
async function uploadVideo(ctx, filePath, width, height, duration, thumbnail, fileSize, startTime) {
  try {
    const isUploadAsDoc = await getUploadAsDoc(ctx.from.id);
    const botUsername = (await ctx.telegram.getMe()).username;
    const fileName = path.basename(filePath);
    const caption = captionTemplate.replace('{botUsername}', `@${botUsername}`) +
      `\n\n**File Name:** \`${fileName}\`\n**Duration:** \`${formatTimespan(duration)}\`\n**File Size:** \`${humanbytes(fileSize)}\``;
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

    await new Promise((resolve) => setTimeout(resolve, timeGap * 1000));
    if (logChannel) {
      const forwarded = await sent.copy(logChannel);
      await ctx.telegram.sendMessage(
        logChannel,
        `**User:** [${ctx.from.first_name}](tg://user?id=${ctx.from.id})\n**Username:** @${ctx.from.username || 'None'}\n**UserID:** \`${ctx.from.id}\``,
        { reply_to_message_id: forwarded.message_id, parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }

    await ctx.editMessageText('Video uploaded successfully!');
  } catch (error) {
    console.error('Upload error:', error);
    try {
      await ctx.editMessageText(`Failed to upload video!\nError: ${error.message}`);
    } catch (editError) {
      await ctx.reply(`Failed to upload video!\nError: ${error.message}`);
    }
  }
}

// دستور /start
bot.start(async (ctx) => {
  await addUserToDatabase(ctx);
  if ((await forceSub(ctx)) !== 200) return;
  await ctx.reply(
    `Hi Unkil, I am Video Merge Bot!\nI can Merge Multiple Videos in One Video. Video Formats should be same.\n\nMade by @Savior_128`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('Developer - @Savior_128', 'https://t.me/Savior_128')],
        [
          Markup.button.url('Support Group', 'https://t.me/linux_repo'),
          Markup.button.url('Bots Channel', 'https://t.me/Discovery_Updates'),
        ],
        [Markup.button.callback('Open Settings', 'openSettings')],
        [Markup.button.callback('Close', 'closeMeh')],
      ]),
    }
  );
});

// مدیریت ویدیوها
bot.on('video', async (ctx) => {
  await addUserToDatabase(ctx);
  if ((await forceSub(ctx)) !== 200) return;
  const file = ctx.message.video;
  const fileName = file.file_name || 'video.mp4';
  const extension = fileName.split('.').pop().toLowerCase();

  if (!['mp4', 'mkv', 'webm'].includes(extension)) {
    return ctx.reply('Only MP4, MKV, or WEBM videos are allowed!', { reply_to_message_id: ctx.message.message_id });
  }

  if (!FormatDB[ctx.from.id]) FormatDB[ctx.from.id] = extension;
  if (FormatDB[ctx.from.id] !== extension) {
    return ctx.reply(`Please send only ${FormatDB[ctx.from.id].toUpperCase()} videos!`, { reply_to_message_id: ctx.message.message_id });
  }

  const inputFile = path.join(downPath, ctx.from.id.toString(), 'input.txt');
  if (await fs.access(inputFile).then(() => true).catch(() => false)) {
    return ctx.reply('A process is already running! Please wait.');
  }

  const { isInGap, sleepTime } = await checkTimeGap(ctx.from.id);
  if (isInGap) {
    return ctx.reply(`No flooding! Wait ${sleepTime}s before sending another video.`, { reply_to_message_id: ctx.message.message_id });
  }

  if (!QueueDB[ctx.from.id]) QueueDB[ctx.from.id] = [];
  if (QueueDB[ctx.from.id].length >= maxVideos) {
    return ctx.reply(`Max ${maxVideos} videos allowed! Press Merge Now.`, {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('Merge Now', 'mergeNow')]]),
    });
  }

  QueueDB[ctx.from.id].push(ctx.message.message_id);
  const messageText = QueueDB[ctx.from.id].length === maxVideos ? 'Press Merge Now!' : 'Send next video or press Merge Now!';
  const markup = await makeButtons(ctx, ctx.message, QueueDB);

  const editable = await ctx.reply('Adding video to queue...', { reply_to_message_id: ctx.message.message_id });
  await new Promise((resolve) => setTimeout(resolve, timeGap * 1000));
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, editable.message_id, null, 'Video added to queue!');
  } catch (editError) {
    await ctx.reply('Video added to queue!');
  }
  if (ReplyDB[ctx.from.id]) await ctx.telegram.deleteMessage(ctx.chat.id, ReplyDB[ctx.from.id]).catch(() => {});
  const reply = await ctx.reply(messageText, { reply_markup: Markup.inlineKeyboard(markup), reply_to_message_id: ctx.message.message_id });
  ReplyDB[ctx.from.id] = reply.message_id;
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
  if ((await forceSub(ctx)) !== 200) return; // اصلاح خطای نحوی: نقل‌قول اضافی حذف شد
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
  let done = 0,
    failed = 0,
    success = 0;
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
bot.action('mergeNow', async (ctx) => {
  const userId = ctx.from.id;
  if (!QueueDB[userId] || QueueDB[userId].length < 2) {
    await ctx.answerCbQuery('Need at least 2 videos to merge!', { show_alert: true });
    await ctx.deleteMessage();
    return;
  }

  await ctx.editMessageText('Preparing to merge videos...');
  const userDir = await ensureDir(userId);
  const inputFile = path.join(userDir, 'input.txt');
  const videoPaths = [];

  for (const messageId of QueueDB[userId].sort()) {
    try {
      const message = await ctx.telegram.getMessages(ctx.chat.id, messageId);
      const video = message[0].video;
      const filePath = path.join(userDir, `${messageId}.${FormatDB[userId]}`);
      await ctx.editMessageText(`Downloading ${video.file_name || 'unnamed_file'}...`);
      const startTime = Date.now() / 1000;
      await downloadFile(ctx, video.file_id, filePath, (current, total) =>
        progressForTelegraf(current, total, 'Downloading', ctx, startTime)
      );
      videoPaths.push(`file '${filePath}'`);
    } catch (error) {
      console.error('Download error:', error);
      QueueDB[userId] = QueueDB[userId].filter((id) => id !== messageId);
      await ctx.editMessageText('File skipped!');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  if (videoPaths.length < 2) {
    await ctx.editMessageText('Not enough valid videos to merge!');
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }

  await fs.writeFile(inputFile, videoPaths.join('\n'));
  const mergedVidPath = await mergeVideo(inputFile, userId, ctx, FormatDB[userId]);
  if (!mergedVidPath) {
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }

  const fileSize = (await fs.stat(mergedVidPath)).size;
  if (fileSize > 2097152000) {
    await ctx.editMessageText(`File too large (${humanbytes(fileSize)}). Uploading to Streamtape...`);
    await uploadToStreamtape(mergedVidPath, ctx, fileSize);
    await deleteAll(userDir);
    delete QueueDB[userId];
    delete FormatDB[userId];
    return;
  }

  await ctx.editMessageText(
    'Do you want to rename the file?',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('Rename File', 'renameFile_Yes')],
        [Markup.button.callback('Keep Default', 'renameFile_No')],
      ]),
    }
  );
});

bot.action('cancelProcess', async (ctx) => {
  await ctx.editMessageText('Cancelling process...');
  await deleteAll(path.join(downPath, ctx.from.id.toString()));
  delete QueueDB[ctx.from.id];
  delete FormatDB[ctx.from.id];
  await ctx.editMessageText('Process cancelled!');
});

bot.action('showThumbnail', async (ctx) => {
  try {
    const fileId = await getThumbnail(ctx.from.id);
    if (fileId) {
      await ctx.answerCbQuery('Sending thumbnail...');
      await ctx.telegram.sendPhoto(ctx.chat.id, fileId, {
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

bot.action('showQueueFiles', async (ctx) => {
  try {
    const markup = await makeButtons(ctx, ctx.message, QueueDB);
    await ctx.editMessageText('Queue Files:', { reply_markup: Markup.inlineKeyboard(markup) });
  } catch (error) {
    console.error('Show queue error:', error);
    await ctx.answerCbQuery('Error showing queue files.');
  }
});

bot.action(/showFileName_(\d+)/, async (ctx) => {
  const messageId = parseInt(ctx.match[1]);
  try {
    const message = await ctx.telegram.getMessages(ctx.chat.id, messageId);
    const media = message[0].video || message[0].document;
    if (media) {
      await ctx.answerCbQuery(`File: ${media.file_name || 'unnamed_file'}`, { show_alert: true });
    } else {
      await ctx.answerCbQuery('File not found!', { show_alert: true });
    }
  } catch (error) {
    console.error('Show file name error:', error);
    await ctx.answerCbQuery('Error fetching file.');
  }
});

bot.action('openSettings', async (ctx) => {
  await openSettings(ctx, ctx.message);
});

bot.action('refreshFsub', async (ctx) => {
  if ((await forceSub(ctx)) === 200) {
    await ctx.editMessageText(
      `Hi Unkil, I am Video Merge Bot!\nI can Merge Multiple Videos in One Video. Video Formats should be same.\n\nMade by @Savior_128`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url('Developer - @Savior_128', 'https://t.me/Savior_128')],
          [
            Markup.button.url('Support Group', 'https://t.me/linux_repo'),
            Markup.button.url('Bots Channel', 'https://t.me/Discovery_Updates'),
          ],
          [Markup.button.callback('Open Settings', 'openSettings')],
          [Markup.button.callback('Close', 'closeMeh')],
        ]),
      }
    );
  }
});

bot.action(/renameFile_(Yes|No)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!QueueDB[userId] || QueueDB[userId].length === 0) {
    await ctx.answerCbQuery('Queue is empty!', { show_alert: true });
    return;
  }

  let mergedVidPath = path.join(downPath, userId.toString(), `[@Savior_128]_Merged.${FormatDB[userId]}`);
  if (ctx.match[1] === 'Yes') {
    await ctx.editMessageText('Send the new file name:');
    const newName = await waitForText(ctx);
    if (newName) {
      const safeName = newName.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
      const newPath = path.join(downPath, userId.toString(), `${safeName}.${FormatDB[userId]}`);
      await fs.rename(mergedVidPath, newPath);
      mergedVidPath = newPath;
      await ctx.editMessageText(`Renamed to ${safeName}.${FormatDB[userId]}`);
    } else {
      await ctx.editMessageText('No name provided. Using default name.');
    }
  }

  await ctx.editMessageText('Extracting video data...');
  const { duration, width, height } = await getVideoMetadata(mergedVidPath);
  const fileSize = (await fs.stat(mergedVidPath)).size;
  let thumbnail = await getThumbnail(userId);
  if (thumbnail) {
    const thumbPath = path.join(downPath, userId.toString(), 'thumbnail.jpg');
    await downloadFile(ctx, thumbnail, thumbPath);
    await sharp(thumbPath).resize(width, height).jpeg().toFile(thumbPath);
    thumbnail = thumbPath;
  } else {
    thumbnail = await generateThumbnail(mergedVidPath, userId, duration);
  }

  const shouldGenerateSs = await getGenerateSs(userId);
  const shouldGenerateSample = await getGenerateSampleVideo(userId);
  if (shouldGenerateSs) {
    const screenshots = await generateScreenshots(mergedVidPath, path.join(downPath, userId.toString()), 4, duration);
    if (screenshots.length > 0) {
      await ctx.telegram.sendMediaGroup(
        ctx.chat.id,
        screenshots.map((s) => ({ type: 'photo', media: { source: s } }))
      );
    }
  }
  if (shouldGenerateSample) {
    const samplePath = await cutSmallVideo(
      mergedVidPath,
      path.join(downPath, userId.toString()),
      0,
      Math.min(30, duration),
      FormatDB[userId]
    );
    if (samplePath) {
      await ctx.telegram.sendVideo(ctx.chat.id, { source: samplePath }, { caption: 'Sample Video' });
    }
  }

  const startTime = Date.now() / 1000;
  await uploadVideo(ctx, mergedVidPath, width, height, duration, thumbnail, fileSize, startTime);
  await deleteAll(path.join(downPath, userId.toString()));
  delete QueueDB[userId];
  delete FormatDB[userId];
});

// توابع کمکی
async function downloadFile(ctx, fileId, filePath, progressCallback) {
  try {
    const file = await ctx.telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const response = await axios.get(url, {
      responseType: 'stream',
      onDownloadProgress: (progressEvent) => {
        if (progressCallback && progressEvent.total) {
          progressCallback(progressEvent.loaded, progressEvent.total);
        }
      },
    });
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

async function deleteAll(root) {
  try {
    if (await fs.access(root).then(() => true).catch(() => false)) {
      await fs.rm(root, { recursive: true, force: true });
      return true;
    }
    console.log(`Folder '${root}' does not exist.`);
    return false;
  } catch (error) {
    console.error(`Error deleting folder '${root}':`, error);
    return false;
  }
}

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
      [Markup.button.callback('Show Queue Files', 'showQueueFiles')],
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

async function waitForText(ctx) {
  return new Promise((resolve) => {
    const handler = (ctx) => {
      if (ctx.message.text) {
        bot.removeListener('text', handler);
        resolve(ctx.message.text);
      }
    };
    bot.on('text', handler);
    setTimeout(() => {
      bot.removeListener('text', handler);
      resolve(null);
    }, 300000);
  });
}

async function generateThumbnail(filePath, userId, duration) {
  try {
    const thumbPath = path.join(downPath, userId.toString(), 'thumbnail.jpg');
    const ttl = Math.floor(Math.random() * duration);
    await runFffmpegCommand([
      'ffmpeg',
      '-i',
      filePath,
      '-ss',
      ttl.toString(),
      '-vframes',
      '1',
      thumbPath,
    ]);
    await sharp(thumbPath).jpeg().toFile(thumbPath);
    return thumbPath;
  } catch (error) {
    console.error('Thumbnail error:', error);
    return null;
  }
}

async function getVideoMetadata(filePath) {
  try {
    const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration:stream=width,height -of json ${filePath}`);
    const data = JSON.parse(stdout);
    return {
      duration: Math.round(parseFloat(data.format.duration)),
      width: data.streams[0].width || 100,
      height: data.streams[0].height || 100,
    };
  } catch (error) {
    console.error('Metadata error:', error);
    return { duration: 1, width: 100, height: 100 };
  }
}

bot.action('triggerUploadMode', async (ctx) => {
  try {
    const uploadAsDoc = await getUploadAsDoc(ctx.from.id);
    await setUploadAsDoc(ctx.from.id, !uploadAsDoc);
    await openSettings(ctx, ctx.message);
  } catch (error) {
    console.error('Toggle upload mode error:', error);
    await ctx.answerCbQuery('Error updating settings.');
  }
});

bot.action('triggerGenSample', async (ctx) => {
  try {
    const generateSampleVideo = await getGenerateSampleVideo(ctx.from.id);
    await setGenerateSampleVideo(ctx.from.id, !generateSampleVideo);
    await openSettings(ctx, ctx.message);
  } catch (error) {
    console.error('Toggle sample video error:', error);
    await ctx.answerCbQuery('Error updating settings.');
  }
});

bot.action('triggerGenSS', async (ctx) => {
  try {
    const generateSs = await getGenerateSs(ctx.from.id);
    await setGenerateSs(ctx.from.id, !generateSs);
    await openSettings(ctx, ctx.message);
  } catch (error) {
    console.error('Toggle SS error:', error);
    await ctx.answerCbQuery('Error updating settings.');
  }
});

bot.action('closeMeh', async (ctx) => {
  try {
    await ctx.deleteMessage();
    if (ctx.message.reply_to_message) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id);
    }
  } catch (error) {
    console.error('Close error:', error);
  }
});

// راه‌اندازی ربات
(async () => {
  try {
    await connectMongoDB();
    const webhookUrl = `https://${process.env.VERCEL_URL}/api`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log('Webhook set to:', webhookUrl);
    console.log('Bot started');
  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }
})();

// مدیریت Webhook برای Vercel
module.exports = async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
};