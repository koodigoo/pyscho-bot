/**
 * index.js — Telegram bot (Telegraf) + Supabase
 * Фиксы под твои пожелания:
 * - Supabase НЕ блокирует UX: записи идут fire-and-forget + таймауты
 * - Пользователь всегда получает ответ (особенно на финальных шагах)
 * - Fallback из cache (RAM), если Supabase временно не отвечает/не успел записать
 * - Единый withTimeout (без дублей), безопасные try/catch в обработчиках
 */

require("dotenv").config();

console.log("ENV CHECK:", {
  BOT_TOKEN: !!process.env.BOT_TOKEN,
  SUPABASE_URL: !!process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_CHAT_ID: !!process.env.ADMIN_CHAT_ID,
  MARIA_CONTACT_URL: !!process.env.MARIA_CONTACT_URL,
});

const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");

const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_CHAT_ID,
  MARIA_CONTACT_URL,
} = process.env;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing in .env");

// Фичи включаются автоматически, если переменные есть в .env
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const hasAdmin = Boolean(ADMIN_CHAT_ID);
const hasMariaUrl = Boolean(MARIA_CONTACT_URL);

const supabase = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const bot = new Telegraf(BOT_TOKEN);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// RAM cache: чтобы сценарий не зависел от Supabase в моменте
// user_id -> { status, frequency }
const cache = new Map();

/** ---------- Utils ---------- */
function withTimeout(promise, ms, label = "timeout") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function fireAndForget(p) {
  Promise.resolve(p).catch(() => {});
}

function userMeta(ctx) {
  const u = ctx.from || {};
  return {
    user_id: u.id,
    username: u.username || null,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
  };
}

async function upsertLead(ctx, patch) {
  if (!supabase) return;

  const payload = { ...userMeta(ctx), ...patch };
  try {
    const q = supabase.from("leads").upsert(payload, { onConflict: "user_id" });
    await withTimeout(q, 4000, "supabase upsert timeout");
  } catch (e) {
    console.error("[supabase] upsert failed:", e?.message || e);
  }
}

async function getLead(userId) {
  if (!supabase) return null;

  try {
    const q = supabase
      .from("leads")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    const res = await withTimeout(q, 4000, "supabase select timeout");
    if (res?.error) {
      console.error("[supabase] select error:", res.error);
      return null;
    }
    return res?.data || null;
  } catch (e) {
    console.error("[supabase] select failed:", e?.message || e);
    return null;
  }
}

/** ---------- Copy ---------- */
const COPY = {
  start:
    "Здравствуйте. Я бережный помощник Марии Губкиной. Если сейчас вам трудно найти опору или эмоции переполняют — я рядом. Выберите, что вы чувствуете прямо сейчас:",

  states: {
    anxiety: {
      label: "😰 Тревога / Паника",
      explain:
        'Когда нас накрывает волна тревоги, мозг начинает работать в режиме катастрофизации. Он "прокручивает" худшие сценарии будущего так ярко, что тело начинает верить, будто это происходит прямо сейчас. Сердце бьется чаще, дыхание становится поверхностным — это древний механизм защиты, который включился не вовремя. Важно понять: эти мысли — не факты. Сейчас вы находитесь в безопасности, и вашей нервной системе просто нужен физический сигнал, чтобы выйти из режима "бей или беги".',
      technique:
        "Давайте попробуем восстановить ритм через тело. Сделайте глубокий, но спокойный вдох на 4 счета. Представьте, как воздух наполняет легкие до самого низа. Задержите дыхание на 4 счета. Теперь плавно, как через соломинку, выдыхайте на 4 счета, отпуская напряжение из челюсти и плеч. Снова задержка на 4. Повторите этот цикл 5–7 раз. Вы заметите, как с каждым кругом мысли становятся чуть менее громкими, а пульс замедляется.",
    },
    anger: {
      label: "😡 Гнев / Раздражение",
      explain:
        'Гнев — это огромный импульс энергии, который возник внутри, чтобы защитить ваши границы или ценности. Если мы его подавляем, он превращается в яд для тела или "взрывается" на близких. В этом состоянии бесполезно пытаться "просто успокоиться" головой, потому что гнев живет в мышцах. Чтобы он перестал вас затапливать, нам нужно дать этой энергии безопасный выход, сбросить лишнее напряжение через физическое усилие, не причиняя вреда ни себе, ни окружающим.',
      technique:
        'Прямо сейчас, где бы вы ни были, сожмите кулаки изо всей силы. Напрягите руки, плечи, пресс, даже мышцы лица. Представьте, что вы сжимаете пружину до предела. Держите это напряжение 5–7 секунд... А теперь — резкий, шумный выдох и мгновенное расслабление. Почувствуйте, как тяжесть уходит из рук в пол. Сделайте так трижды. Этот резкий контраст "напряжение-расслабление" дает мозгу команду выключить режим атаки.',
    },
    apathy: {
      label: "😶‍🌫️ Апатия / Сил нет",
      explain:
        'Состояние, когда "сели батарейки", — это часто не лень, а защитное торможение психики. Когда стресса или неопределенности становится слишком много, система просто выключает свет, чтобы не сгореть от перегруза. В такие моменты бесполезно заставлять себя быть продуктивным. Сейчас ваша задача — не совершить подвиг, а мягко "заземлиться", вернуться из вакуума своих мыслей и переживаний в реальный мир, почувствовать опору и вернуть себе контроль над маленькими вещами.',
      technique:
        'Давайте выполним практику "5-4-3-2-1". Медленно оглянитесь вокруг и отметьте 5 предметов синего или зеленого цвета. Прислушайтесь к пространству и выделите 3 разных звука (тик часов, шум за окном, ваше дыхание). Почувствуйте 2 физических ощущения: как одежда касается кожи и как ваши стопы уверенно давят на пол. И, наконец, сделайте один осознанный вдох, чувствуя, как прохладный воздух заходит в ноздри. Вы здесь. Вы в безопасности. Этого на данный момент достаточно.',
    },
  },

  afterTechnique:
    'Я рада, что вы уделили эти несколько минут себе. Даже если стало легче совсем чуть-чуть — это уже важная победа над состоянием.\n\nТакие техники — это бережная "скорая помощь". Они помогают не утонуть в моменте, но, к сожалению, не убирают саму причину, по которой вас "накрывает". Если эмоции затапливают регулярно, значит, внутри накопился критический объем усталости или неразрешенных ситуаций.\n\nЧтобы я могла лучше понять ваш контекст, скажите — как часто вы ловите себя на таких чувствах в последнее время?',

  offerRare:
    "Здорово, что в целом вы справляетесь. Но даже редкие вспышки — это повод прислушаться к себе, пока они не стали системой. Если почувствуете, что хотите разобраться в причинах глубже и укрепить свои внутренние опоры — я буду рада помочь вам на консультации. Иногда одного точного разговора достаточно, чтобы вернуть контроль. Приглашаю вас на короткую ознакомительную встречу (30 минут).",

  offerRegular:
    'Спасибо за честность. Жить в таком режиме — это огромная, изматывающая нагрузка на вашу нервную систему. Это как ехать на автомобиле, у которого постоянно мигает лампочка перегрева: можно подливать воды, но нужно чинить мотор.\n\nСамопомощь — это важно, но в одиночку найти выход из замкнутого круга бывает очень трудно. Чтобы не довести себя до полного выгорания, я приглашаю вас на короткую ознакомительную встречу (30 минут).\n\nМы в спокойной обстановке разберем вашу ситуацию, найдем главный "триггер", который сливает ваш ресурс, и наметим план, как вернуть вам устойчивость и радость. Это будет бережный профессиональный разговор, который ни к чему вас не обязывает.',
};

const BTN = {
  done: "✅ Сделал(а), стало легче",
  book: "🗓 Записаться на встречу с Марией",
};

const FREQUENCY = {
  rare: "Это разовый эпизод (редко)",
  weekly: "Стабильно 1–2 раза в неделю",
  daily: "Почти каждый день, я в этом живу",
};

/** ---------- Menus ---------- */
function menuStates() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(COPY.states.anxiety.label, "state:anxiety")],
    [Markup.button.callback(COPY.states.anger.label, "state:anger")],
    [Markup.button.callback(COPY.states.apathy.label, "state:apathy")],
  ]);
}

function menuFrequencies() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(FREQUENCY.rare, "freq:rare")],
    [Markup.button.callback(FREQUENCY.weekly, "freq:weekly")],
    [Markup.button.callback(FREQUENCY.daily, "freq:daily")],
  ]);
}
async function sendFinalToUser(ctx, text, extra) {
  const chatId =
    ctx.chat?.id ??
    ctx.callbackQuery?.message?.chat?.id ??
    ctx.from?.id;

  console.log("[sendFinalToUser] chatId:", chatId);

  // 1) Самый надежный путь: редактируем сообщение, где была кнопка "Записаться"
  try {
    if (ctx.callbackQuery?.message?.message_id) {
      await ctx.editMessageText(text, extra);
      return true;
    }
  } catch (e) {
    console.error("[tg] editMessageText failed:", e?.message || e);
  }

  // 2) Фолбэк: шлём напрямую в чат
  try {
    if (!chatId) throw new Error("no chatId");
    await ctx.telegram.sendMessage(chatId, text, extra);
    return true;
  } catch (e) {
    console.error("[tg] sendMessage failed:", e?.message || e);
  }

  // 3) Последний шанс: обычный reply
  try {
    await ctx.reply(text, extra);
    return true;
  } catch (e) {
    console.error("[tg] reply failed:", e?.message || e);
    return false;
  }
}

/** ---------- Logging / middleware ---------- */
bot.use(async (ctx, next) => {
  try {
    if (ctx.callbackQuery?.data) console.log("[callback]", ctx.callbackQuery.data);
    return await next();
  } catch (e) {
    console.error("[middleware] error:", e?.message || e);
    // не роняем бота
  }
});

/** ---------- Diagnostics ---------- */
bot.command("id", (ctx) => ctx.reply(`chat_id: ${ctx.chat.id}`));

bot.command("health", (ctx) =>
  ctx.reply(
    [
      "healthcheck ✅",
      `supabase: ${hasSupabase ? "on" : "off"}`,
      `admin_chat: ${hasAdmin ? "on" : "off"}`,
      `maria_url: ${hasMariaUrl ? "on" : "off"}`,
    ].join("\n")
  )
);

// (Опционально, удобно для проверки отправки Марии)
bot.command("pingadmin", async (ctx) => {
  if (!hasAdmin) return ctx.reply("ADMIN_CHAT_ID не задан ❌");
  try {
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, "ping ✅ бот может писать в ADMIN_CHAT_ID");
    return ctx.reply("Ок, пинг в админ-чат отправлен ✅");
  } catch (e) {
    console.error("[pingadmin] send failed:", e?.message || e);
    return ctx.reply("Пинг не ушёл ❌ См. ошибку в терминале.");
  }
});

/** ---------- Helpers: admin notify ---------- */
function buildAdminText({ username, userId, statusHuman, freqHuman }) {
  const uname = username ? `@${username}` : "(без username)";
  const profileLink = username ? `https://t.me/${username}` : null;

  return (
    `Новый лид из бота\n` +
    `Пользователь: ${uname} (id: ${userId})\n` +
    `Состояние: ${statusHuman}\n` +
    `Частота: ${freqHuman}\n` +
    (profileLink ? `Профиль: ${profileLink}\n` : "")
  );
}

async function notifyAdminInBackground(ctx) {
  if (!hasAdmin) return;

  // Берём данные быстро из cache, а затем пробуем уточнить через Supabase (без влияния на UX)
  const mem = cache.get(ctx.from.id) || {};
  const from = ctx.from || {};

  // Попытка подтянуть из Supabase (с таймаутом внутри getLead)
  const lead = await getLead(ctx.from.id);

  const statusKey = lead?.status || mem.status;
  const freqKey = lead?.frequency || mem.frequency;

  const statusHuman = statusKey ? (COPY.states[statusKey]?.label || statusKey) : "—";
  const freqHuman = freqKey ? (FREQUENCY[freqKey] || freqKey) : "—";

  const username = lead?.username || from.username || null;
  const userId = lead?.user_id || from.id;

  const adminText = buildAdminText({ username, userId, statusHuman, freqHuman });

  try {
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, adminText);
  } catch (e) {
    console.error("[admin notify] send failed:", e?.message || e);
  }
}

/** ---------- Scenario ---------- */
bot.start(async (ctx) => {
  // Supabase — в фоне (не блокируем UX)
  fireAndForget(upsertLead(ctx, { last_step: "start" }));
  return ctx.reply(COPY.start, menuStates());
});

  bot.action(/^state:(anxiety|anger|apathy)$/, async (ctx) => {
  try {
    ctx.answerCbQuery("Ок").catch(() => {});

    const status = ctx.match[1];
    const block = COPY.states[status];

    // Cache
    cache.set(ctx.from.id, { ...(cache.get(ctx.from.id) || {}), status });

    // Supabase — в фоне
    fireAndForget(upsertLead(ctx, { status, last_step: "technique" }));

    await delay(2000);
    await ctx.reply(block.explain);
    await ctx.reply(
      block.technique,
      Markup.inlineKeyboard([Markup.button.callback(BTN.done, "done")])
    );
  } catch (e) {
    console.error("[state handler] error:", e?.message || e);
    // user-facing fallback
    return ctx.reply("Что-то пошло не так. Попробуйте ещё раз: /start");
  }
});

bot.action("done", async (ctx) => {
  try {
    ctx.answerCbQuery("Ок").catch(() => {});
    fireAndForget(upsertLead(ctx, { last_step: "frequency" }));
    return ctx.reply(COPY.afterTechnique, menuFrequencies());
  } catch (e) {
    console.error("[done handler] error:", e?.message || e);
    return ctx.reply("Не получилось продолжить. Давайте заново: /start");
  }
});

bot.action(/^freq:(rare|weekly|daily)$/, async (ctx) => {
  ctx.answerCbQuery("Ок").catch(() => {});

  const frequency = ctx.match[1];

  // cache, чтобы не зависеть от Supabase
  cache.set(ctx.from.id, { ...(cache.get(ctx.from.id) || {}), frequency });

  // Пишем в Supabase в фоне
  upsertLead(ctx, { frequency, last_step: "offer" });

  // ВАЖНО: на этом шаге НЕ даём URL-кнопку, чтобы юзер не "улетел" мимо book
  const buttons = [[Markup.button.callback(BTN.book, "book")]];

  const offerText = frequency === "rare" ? COPY.offerRare : COPY.offerRegular;

  await ctx
    .reply(offerText, Markup.inlineKeyboard(buttons))
    .catch((e) => console.error("[tg] offer reply failed:", e?.message || e));
});


bot.action("book", async (ctx) => {
  ctx.answerCbQuery("Принято").catch(() => {});

  // Supabase — в фоне (не блокирует доставку)
  upsertLead(ctx, { last_step: "booked" });

  // ✅ Финальный текст
  const finalText = "Принято ✅ Мария свяжется с вами в ближайшее время.";

  // Кнопка написать Марии (опционально)
  const extra = hasMariaUrl
    ? Markup.inlineKeyboard([Markup.button.url("Написать Марии", MARIA_CONTACT_URL)])
    : undefined;

  // 1) Сначала отправляем финал пользователю (надежная функция)
  await sendFinalToUser(ctx, finalText, extra);

  // 2) Уведомление Марии — в фоне, не блокирует пользователя
  (async () => {
    try {
      const lead = await getLead(ctx.from.id);
      const mem = cache.get(ctx.from.id) || {};

      const statusKey = lead?.status || mem.status;
      const freqKey = lead?.frequency || mem.frequency;

      const statusHuman = statusKey ? (COPY.states[statusKey]?.label || statusKey) : "—";
      const freqHuman = freqKey ? (FREQUENCY[freqKey] || freqKey) : "—";

      const uname =
        (lead?.username || ctx.from?.username)
          ? `@${lead?.username || ctx.from.username}`
          : "(без username)";

      const userId = lead?.user_id || ctx.from.id;

      const adminText =
        `Новый лид из бота\n` +
        `Пользователь: ${uname} (id: ${userId})\n` +
        `Состояние: ${statusHuman}\n` +
        `Частота: ${freqHuman}\n`;

      if (hasAdmin) {
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID, adminText);
      }
    } catch (e) {
      console.error("[tg] admin notify error:", e?.message || e);
    }
  })();
});




/** ---------- Safety ---------- */
bot.catch((err) => console.error("[bot.catch] error:", err));

bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log("Bot is running...");
    console.log(`supabase: ${hasSupabase ? "on" : "off"}`);
    console.log(`admin_chat: ${hasAdmin ? "on" : "off"}`);
    console.log(`maria_url: ${hasMariaUrl ? "on" : "off"}`);
  })
  .catch((e) => console.error("Launch failed:", e));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
