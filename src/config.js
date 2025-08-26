require('dotenv').config();

module.exports = {
  telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN,

  // Прямо указываем id и название каналов
  required_channels: [
    { id: '-1002201211686', name: 'ФУРИХИХИ аутсайд' },
    { id: '-1001610659070', name: 'Палата 79⁴² [Саша Врач] [Прайм Пати]' }
  ],

  rehub_admin_chat_id: process.env.REHUB_ADMIN_CHAT_ID,
  support_thread_id: process.env.SUPPORT_THREAD_ID || null,
  log_thread_id: process.env.LOG_THREAD_ID || null,
  private_chat_id: process.env.PRIVATE_CHAT_ID,
};
