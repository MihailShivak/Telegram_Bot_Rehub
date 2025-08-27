const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const {
  telegram_bot_token,
  required_channels,
  rehub_admin_chat_id,
  support_thread_id,
  log_thread_id,
  private_chat_id
} = require("./config");

const bot = new TelegramBot(telegram_bot_token, {
  polling: true,
  filepath: false
});

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SPAM_PROTECTION_FILE = path.join(DATA_DIR, "spam_protection.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let usersData = {};
let spamProtectionData = {};
const userState = {};
const activeInviteLinks = new Map();
const PENDING_JOINS = new Map();

const loadUserData = () => {
  try {
    if (fs.existsSync(USERS_FILE)) {
      usersData = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) || {};
    }
  } catch (e) {
    console.error("Ошибка загрузки users.json:", e);
    usersData = {};
  }
};

const saveUserData = () => {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
  } catch (e) {
    console.error("Ошибка сохранения users.json:", e);
  }
};

const loadSpamProtectionData = () => {
  try {
    if (fs.existsSync(SPAM_PROTECTION_FILE)) {
      spamProtectionData = JSON.parse(fs.readFileSync(SPAM_PROTECTION_FILE, "utf8")) || {};
    }
  } catch (e) {
    console.error("Ошибка загрузки spam_protection.json:", e);
    spamProtectionData = {};
  }
};

const saveSpamProtectionData = () => {
  try {
    fs.writeFileSync(SPAM_PROTECTION_FILE, JSON.stringify(spamProtectionData, null, 2));
  } catch (e) {
    console.error("Ошибка сохранения spam_protection.json:", e);
  }
};

loadUserData();
loadSpamProtectionData();

// Очистка устаревших данных спам-защиты
setInterval(() => {
  const now = Date.now();
  let changed = false;
  
  Object.keys(spamProtectionData).forEach(userId => {
    if (spamProtectionData[userId].expiresAt < now) {
      delete spamProtectionData[userId];
      changed = true;
    }
  });
  
  if (changed) {
    saveSpamProtectionData();
  }
}, 60000);

// Очистка устаревших ожиданий и ссылок
setInterval(() => {
  const now = Date.now();
  
  // Очистка PENDING_JOINS
  for (const [userId, data] of PENDING_JOINS.entries()) {
    if (now > data.expiresAt) {
      PENDING_JOINS.delete(userId);
    }
  }
  
  // Очистка activeInviteLinks
  for (const [link, userId] of activeInviteLinks.entries()) {
    const userData = usersData[userId];
    if (userData && (now - userData.checkedAt) > 30000) {
      activeInviteLinks.delete(link);
    }
  }
}, 10000);

const generateChannelLink = (channelId) => {
  if (!channelId) return null;
  
  if (channelId.startsWith("@")) {
    return `https://t.me/${channelId.slice(1)}`;
  }
  
  if (channelId.startsWith("-100")) {
    const numericId = channelId.replace(/^-100/, "");
    return `https://t.me/c/${numericId}`;
  }
  
  if (channelId.includes("t.me/")) {
    return channelId;
  }
  
  return `https://t.me/c/${channelId}`;
};

const checkUserSubscriptions = async (userId) => {
  try {
    if (!required_channels || !Array.isArray(required_channels)) {
      throw new Error("Invalid required_channels configuration");
    }

    const results = await Promise.all(
      required_channels.map(async (channel) => {
        try {
          if (!channel?.id) return { subscribed: false, channel };
          
          const member = await bot.getChatMember(channel.id, userId);
          return {
            subscribed: ["member", "administrator", "creator"].includes(member.status),
            channel
          };
        } catch (e) {
          console.error(`Ошибка проверки канала ${channel.id}:`, e.message);
          return { subscribed: false, channel };
        }
      })
    );

    return {
      allSubscribed: results.every(r => r.subscribed),
      missingChannels: results.filter(r => !r.subscribed).map(r => r.channel?.name || "Неизвестный канал")
    };
  } catch (e) {
    console.error("Ошибка в checkUserSubscriptions:", e);
    return {
      allSubscribed: false,
      missingChannels: required_channels.map(c => c?.name || "Неизвестный канал")
    };
  }
};

const checkSpamProtection = (userId) => {
  const userData = spamProtectionData[userId];
  if (!userData) return { blocked: false, remainingTime: 0 };
  
  if (userData.expiresAt > Date.now()) {
    return {
      blocked: true,
      remainingTime: Math.ceil((userData.expiresAt - Date.now()) / 1000)
    };
  }
  
  return { blocked: false, remainingTime: 0 };
};

const addSpamPenalty = (userId, durationMinutes = 5) => {
  spamProtectionData[userId] = {
    count: (spamProtectionData[userId]?.count || 0) + 1,
    expiresAt: Date.now() + (durationMinutes * 60 * 1000),
    lastPenalty: Date.now()
  };
  saveSpamProtectionData();
};

const revokeInviteLink = async (inviteLink) => {
  try {
    await bot.revokeChatInviteLink(private_chat_id, inviteLink);
    console.log(`Инвайт-ссылка отозвана: ${inviteLink}`);
  } catch (error) {
    console.error("Ошибка при отзыве инвайт-ссылки:", error);
  }
};

// Обработчик новых участников чата
bot.on("chat_member", async (update) => {
  if (update.chat.id.toString() !== private_chat_id.toString()) return;
  if (update.new_chat_member?.status !== "member") return;

  const joiningUserId = update.new_chat_member.user.id;
  const inviteLink = update.invite_link?.invite_link;

  let isLegitimate = false;
  let expectedUserId = null;

  if (inviteLink && activeInviteLinks.has(inviteLink)) {
    expectedUserId = activeInviteLinks.get(inviteLink);
    isLegitimate = (joiningUserId === expectedUserId);
    activeInviteLinks.delete(inviteLink);
  }
  
  if (!isLegitimate) {
    for (const [userId, data] of PENDING_JOINS.entries()) {
      if (Date.now() < data.expiresAt) {
        if (joiningUserId === userId) {
          isLegitimate = true;
          expectedUserId = userId;
          PENDING_JOINS.delete(userId);
          break;
        }
      }
    }
  }

  if (!isLegitimate && usersData[joiningUserId]?.inviteLink) {
    isLegitimate = true;
    expectedUserId = joiningUserId;
  }

  if (!isLegitimate) {
    try {
      console.log(`🚫 Кикаем нарушителя ${joiningUserId}`);
      
      await bot.banChatMember(private_chat_id, joiningUserId);
      await bot.unbanChatMember(private_chat_id, joiningUserId);
      
      if (inviteLink) {
        await revokeInviteLink(inviteLink);
      }
      
      const violationText = `🚨 НАРУШИТЕЛЬ В ЧАТЕ!
ID: ${joiningUserId}
Username: @${update.new_chat_member.user.username || 'нет'}
Время: ${new Date().toLocaleString()}
Ожидался пользователь: ${expectedUserId || 'неизвестно'}`;

      await bot.sendMessage(rehub_admin_chat_id, violationText, {
        message_thread_id: Number(log_thread_id)
      });
      
    } catch (error) {
      console.error("Ошибка при кике:", error);
    }
  } else {
    console.log(`✅ Легитимный вход: ${joiningUserId}`);
    
    if (usersData[joiningUserId]) {
      usersData[joiningUserId].joinedAt = Date.now();
      saveUserData();
    }
  }
});

bot.setMyCommands([
  { command: "/start", description: "✨ Запустить бота" },
  { command: "/help", description: "📋 Помощь по командам" },
  { command: "/support", description: "🆘 Написать в поддержку" },
  { command: "/stop", description: "🏁 Завершение текущего взаимодействия" },
]);

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  const spamCheck = checkSpamProtection(userId);
  if (spamCheck.blocked) {
    return bot.sendMessage(
      chatId,
      `⏳ Вы временно заблокированы. Попробуйте через ${spamCheck.remainingTime} секунд.`
    );
  }

  try {
    const buttons = required_channels
      .filter(channel => channel?.id)
      .map(channel => ({
        text: channel.name || `Канал ${channel.id}`,
        url: generateChannelLink(channel.id)
      }));

    const keyboard = {
      inline_keyboard: [
        ...buttons.map(button => [button]),
        [{ text: "🔎 Проверить подписки", callback_data: "check" }]
      ]
    };

    await bot.sendMessage(
      chatId,
      "👋 *Добро пожаловать!*\n\n📋 *Для доступа необходимо подписаться на все каналы ниже.*\n\nПосле подписки нажмите \"🔎 Проверить подписки\"",
      { 
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      }
    );
  } catch (e) {
    console.error("Ошибка в /start:", e);
    await bot.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуйте позже.");
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  const spamCheck = checkSpamProtection(userId);
  if (spamCheck.blocked) {
    return bot.sendMessage(
      chatId,
      `⏳ Вы временно заблокированы. Попробуйте через ${spamCheck.remainingTime} секунд.`
    );
  }

  const helpText = `
📝 *Доступные команды:*
/start - ✨ Запустить бота
/help - 📋 Помощь по командам
/support - 🆘 Написать в поддержку
/stop - 🏁 Завершение текущего взаимодействия
  `;
  bot.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
});

bot.onText(/\/support/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  const spamCheck = checkSpamProtection(userId);
  if (spamCheck.blocked) {
    return bot.sendMessage(
      chatId,
      `⏳ Вы временно заблокированы. Попробуйте через ${spamCheck.remainingTime} секунд.`
    );
  }

  userState[chatId] = "awaiting_support";
  bot.sendMessage(chatId, "🆘 Введите текст обращения:");
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  const spamCheck = checkSpamProtection(userId);
  if (spamCheck.blocked) {
    return bot.sendMessage(
      chatId,
      `⏳ Вы временно заблокированы. Попробуйте через ${spamCheck.remainingTime} секунд.`
    );
  }

  const response = userState[chatId] === "awaiting_support"
    ? "❗ Вы вышли из режима обращения"
    : "❗ У вас нет активного взаимодействия\n✨ Чтобы начать - используйте /start";
  delete userState[chatId];
  bot.sendMessage(chatId, response);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const username = query.from.username || "нет username";

  const spamCheck = checkSpamProtection(userId);
  if (spamCheck.blocked) {
    await bot.answerCallbackQuery(query.id, {
      text: `Вы временно заблокированы. Попробуйте через ${spamCheck.remainingTime} секунд.`,
      show_alert: true
    });
    return;
  }

  try {
    await bot.answerCallbackQuery(query.id);

    if (query.data === "support") {
      userState[chatId] = "awaiting_support";
      return await bot.sendMessage(chatId, "🆘 Введите текст обращения:");
    }

    if (query.data === "check") {
      if (usersData[userId]?.inviteLink) {
        addSpamPenalty(userId, 2);
        return await bot.sendMessage(
          chatId,
          "❌ Вы уже получали ссылку ранее. Повторные запросы блокируются.",
          { reply_to_message_id: query.message.message_id }
        );
      }

      const { allSubscribed, missingChannels } = await checkUserSubscriptions(userId);

      if (!allSubscribed) {
        const buttons = required_channels
          .filter(channel => missingChannels.includes(channel?.name || ""))
          .map(channel => ({
            text: `Подписаться на ${channel?.name || "канал"}`,
            url: generateChannelLink(channel?.id)
          }));

        const keyboard = {
          inline_keyboard: [
            ...buttons.map(button => [button]),
            [{ text: "🔄 Проверить снова", callback_data: "check" }]
          ]
        };

        return await bot.sendMessage(
          chatId,
          `❌ Вы не подписаны на: ${missingChannels.join(", ")}`,
          { reply_markup: keyboard }
        );
      }

      const inviteLink = await bot.createChatInviteLink(private_chat_id, {
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 15
      });

      usersData[userId] = {
        id: userId,
        username,
        date: new Date().toISOString(),
        inviteLink: inviteLink.invite_link,
        checkedAt: Date.now()
      };

      activeInviteLinks.set(inviteLink.invite_link, userId);
      PENDING_JOINS.set(userId, {
        inviteLink: inviteLink.invite_link,
        expiresAt: Date.now() + 20000
      });

      saveUserData();

      const notificationText = `📌 Новый пользователь прошел проверку:
ID: ${userId}
Username: @${username}
Дата: ${new Date().toLocaleString()}
Инвайт-ссылка: ${inviteLink.invite_link}`;

      await bot.sendMessage(rehub_admin_chat_id, notificationText, {
        message_thread_id: Number(log_thread_id)
      });

      return await bot.sendMessage(
        chatId,
        `✅ Вы подписаны на все каналы!\nСсылка действительна 15 секунд:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Войти в приватный чат", url: inviteLink.invite_link }]
            ]
          }
        }
      );
    }
  } catch (error) {
    console.error("Ошибка в callback_query:", error);
    await bot.answerCallbackQuery(query.id, {
      text: "⚠️ Произошла ошибка при обработке",
      show_alert: true
    });
    await bot.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуйте позже.");
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith("/") || !userState[chatId]) return;

  const spamCheck = checkSpamProtection(userId);
  if (spamCheck.blocked) {
    return;
  }

  if (userState[chatId] === "awaiting_support") {
    try {
      const userSupportCount = (spamProtectionData[userId]?.supportCount || 0) + 1;
      if (userSupportCount > 3) {
        addSpamPenalty(userId, 10);
        delete userState[chatId];
        return await bot.sendMessage(
          chatId,
          "❌ Слишком много сообщений в поддержку. Вы временно заблокированы."
        );
      }

      const username = msg.from.username ? `@${msg.from.username}` : "не указан";
      const supportMessage = `📩 Новое обращение:
🆔 ID: ${msg.from.id}
👤 Username: ${username}
💬 Сообщение:
${text}`;

      await bot.sendMessage(rehub_admin_chat_id, supportMessage, {
        message_thread_id: Number(support_thread_id)
      });

      if (!spamProtectionData[userId]) {
        spamProtectionData[userId] = { supportCount: 1 };
      } else {
        spamProtectionData[userId].supportCount = userSupportCount;
      }
      saveSpamProtectionData();

      delete userState[chatId];
      await bot.sendMessage(chatId, "✅ Ваше сообщение отправлено в поддержку!");
    } catch (e) {
      console.error("Ошибка при обработке обращения:", e);
      await bot.sendMessage(chatId, "⚠️ Не удалось отправить обращение. Попробуйте позже.");
    }
  }
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});