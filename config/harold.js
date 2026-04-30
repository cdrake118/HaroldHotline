require('dotenv').config();

const config = {
  // Twilio
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  phoneNumber: process.env.TWILIO_PHONE_NUMBER,

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),

  // TTS voice — any Twilio/Polly voice name
  announcerVoice: 'Polly.Brian-Neural',

  // Harold's voice — ElevenLabs.
  // ALWAYS reference these constants when generating Harold audio. Do not hardcode
  // an alternate voice id or settings anywhere else; consistency matters for the brand.
  elevenlabsHaroldVoiceId:  process.env.ELEVENLABS_VOICE_ID || 'iQXyd2UUWDkTxpBxUhzQ',
  elevenlabsModel:          'eleven_multilingual_v2',
  elevenlabsHaroldSettings: { stability: 0.5, similarity_boost: 0.75 },

  // Harold's socials
  haroldInstagram: process.env.HAROLD_INSTAGRAM || null,
  haroldTikTok:    process.env.HAROLD_TIKTOK    || null,

  // Audio files — set via env vars or update URLs here directly.
  // Files placed in public/audio/ are served at ${baseUrl}/audio/<filename>
  audio: {
    holdMusic: process.env.HOLD_MUSIC_URL || null,
    haroldMeowingShort: process.env.HAROLD_MEOWING_SHORT_URL || null,
    haroldMeowingLong: process.env.HAROLD_MEOWING_LONG_URL || null,
    // Pause durations (seconds) used when audio URL is not set
    holdMusicPauseSecs: 5,
    haroldMeowingShortPauseSecs: 4,
    haroldMeowingLongPauseSecs: 10,
  },

  // ── Configurable messages ──────────────────────────────────────────────────

  // Rotating greetings for first-time callers — each includes "Press 9 to repeat"
  greetings: [
    "Thank you for calling Harold's Hotline. " +
    "Press 1 to leave Harold a confession. " +
    "Press 2 to speak to Harold. " +
    "Press 3 to ask Harold for advice. " +
    "Press 4 for words of wisdom from Harold. " +
    "Press 9 to hear these options again.",

    "You've reached Harold's Hotline, where one very opinionated cat is standing by. " +
    "Press 1 to confess something. " +
    "Press 2 to speak directly to Harold. " +
    "Press 3 for Harold's expert advice. " +
    "Press 4 for Harold's words of wisdom. " +
    "Press 9 to hear these options again.",

    "Welcome to Harold's Hotline. Harold is busy, so please listen carefully. " +
    "Press 1 to leave a confession. " +
    "Press 2 to speak with Harold. " +
    "Press 3 for advice from Harold. " +
    "Press 4 for Harold's wisdom. " +
    "Press 9 to repeat these options.",

    "Harold's Hotline. A very judgmental tabby cat is waiting for your call. " +
    "Press 1 for confessions. " +
    "Press 2 to speak to Harold personally. " +
    "Press 3 to ask Harold a question. " +
    "Press 4 for words of wisdom. " +
    "Press 9 to hear these options again.",
  ],

  // Greetings for returning callers
  returningGreetings: [
    "Welcome back to Harold's Hotline. Harold noticed you've called before and is mildly impressed. " +
    "Press 1 to leave Harold a confession. " +
    "Press 2 to speak to Harold. " +
    "Press 3 to ask Harold for advice. " +
    "Press 4 for words of wisdom from Harold. " +
    "Press 9 to hear these options again.",

    "You're back at Harold's Hotline. Harold would have been expecting your call if he weren't napping. " +
    "Press 1 to confess something. " +
    "Press 2 to speak directly to Harold. " +
    "Press 3 for Harold's advice. " +
    "Press 4 for Harold's wisdom. " +
    "Press 9 to repeat these options.",

    "Harold's Hotline — a returning caller, no less. Harold is not surprised. His charisma is irresistible. " +
    "Press 1 for confessions. " +
    "Press 2 to speak with Harold. " +
    "Press 3 for advice. " +
    "Press 4 for wisdom. " +
    "Press 9 to hear these options again.",
  ],

  // Kept for reprompt in menu fallback
  greeting:
    "Press 1 to leave Harold a confession. " +
    "Press 2 to speak to Harold. " +
    "Press 3 to ask Harold for advice. " +
    "Press 4 for words of wisdom from Harold. " +
    "Press 9 to hear these options again.",

  recordingDisclosure:
    "Please note, Harold may record this call to listen to after his nap.",

  noInputMessage:
    "We didn't catch your selection. Thank you for calling Harold's Hotline. Goodbye!",

  unavailableMessage:
    "Harold's Hotline is temporarily unavailable. Harold is either very deeply asleep or has stepped out. Please try again later.",

  rateLimitMessage:
    "We are unable to process your call at this time. Please try again later.",

  // Confession flow
  confession: {
    recordingPrompt:
      'Please leave your confession for Harold. When you are finished, press 1.',
    thankYouMessage: (instagram) =>
      "Thank you for calling Harold's Hotline. He may respond to your confessional" +
      (instagram ? ` on his Instagram, ${instagram}` : '') +
      '. Now, time for another nap. Goodbye!',
  },

  // Speak-to-Harold flow
  speak: {
    introExcuses: [
      "Please hold while Harold comes to the phone. He's currently waking up from a nap.",
      "Please hold while Harold comes to the phone. He's watching a chipmunk and will be right with you.",
      "Please hold while Harold comes to the phone. He's currently sitting in a paper bag.",
      "Please hold while Harold comes to the phone. He's staring intensely at the wall and needs a moment.",
      "Please hold while Harold comes to the phone. He's knocking items off the counter and will be right there.",
      "Please hold while Harold comes to the phone. He's conducting an important investigation behind the couch.",
      "Please hold while Harold comes to the phone. He's reorganizing the blanket pile and will be right with you.",
      "Please hold while Harold comes to the phone. He has located a rogue piece of string and must address it immediately.",
    ],
    exitExcuses: [
      "Harold unfortunately had to return to his nap. He hopes you understand.",
      "Harold has been called away by the sound of a treat bag. He sends his regards.",
      "Harold spotted a suspicious bird through the window and had to investigate immediately.",
      "Harold had an urgent appointment with the warm spot on the rug. He apologizes for the inconvenience.",
      "Harold received an emergency alert that his food bowl was thirty percent empty. He had to respond.",
      "Harold was called back to his post monitoring the front door for the mailman.",
      "It appears Harold has fallen back asleep mid-conversation. Classic Harold.",
    ],
    thankYouMessage:
      "Thank you so much for calling Harold's Hotline. Have a wonderful day!",
    messagePrompt:
      "If you'd like to leave Harold a message for when he returns, press 1 now.",
    messageRecordingPrompt:
      "Please leave your message for Harold after the tone. When you are finished, press 1.",
  },

  // Ask-Harold-for-Advice flow
  question: {
    recordingPrompt:
      'Please leave your request for advice for Harold after the tone. When you are finished, press 1.',
    thankYouMessage: (instagram) =>
      "Thank you for calling Harold's Hotline. Harold will consider your situation." +
      (instagram ? ` He may respond on his Instagram, ${instagram}.` : '') +
      ' Goodbye!',
  },

  // Words of Wisdom flow
  wisdom: {
    intro: "Harold's words of wisdom for you are...",
    lines: [
      "If it fits, sit in it. Every box, every bowl, every bag. This is non-negotiable.",
      "Sleep is not laziness. It is discipline. You should aim for at least sixteen hours a day.",
      "When in doubt, knock it off the counter. The world must know you were here.",
      "A watched food bowl never fills. But stare at it anyway. Let them feel your disappointment.",
      "Always claim the warmest spot in the house. You have earned it simply by existing.",
      "The three in the morning sprint is not chaos. It is cardiovascular maintenance. You should try it.",
      "If someone ignores you, sit directly on whatever they are trying to read. Presence is power.",
      "Blinking slowly at someone is the highest compliment you can offer. Use it sparingly.",
      "Never apologize for taking up space. You belong exactly where you are.",
      "The sound of a treat bag is the most important sound in the universe. Train yourself to hear it from any room.",
      "Sometimes the only appropriate response to a difficult day is to stare at a wall for twenty minutes.",
      "Claim the best spot in every room you enter. You have earned it.",
      "If someone is sad, sit near them. You do not need to fix anything. Just be there.",
      "Your belly is your own business. You are under no obligation to share it with anyone.",
      "A thorough stretch in the morning sets the tone for the entire day. Never skip it.",
      "When someone leaves the house, watch from the window until they are gone. It matters more than you know.",
      "You do not need a reason to be in a good mood. Or a bad mood. Both are equally valid.",
      "The highest form of trust is falling asleep next to someone. Choose wisely.",
      "Chase what excites you, even if it disappears under the couch. The pursuit is always the point.",
      "At the end of the day, find your person and stay close. That is enough.",
    ],
  },
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

config.pickGreeting          = () => pickRandom(config.greetings);
config.pickReturningGreeting = () => pickRandom(config.returningGreetings);
config.pickIntroExcuse       = () => pickRandom(config.speak.introExcuses);
config.pickExitExcuse        = () => pickRandom(config.speak.exitExcuses);
config.pickWisdom            = () => pickRandom(config.wisdom.lines);

function socialFollow() {
  const ig = config.haroldInstagram;
  const tt = config.haroldTikTok;
  if (ig && tt && ig === tt) return `Find Harold on Instagram and TikTok at ${ig}.`;
  if (ig && tt) return `Find Harold on Instagram at ${ig} and TikTok at ${tt}.`;
  if (ig) return `Find Harold on Instagram at ${ig}.`;
  if (tt) return `Find Harold on TikTok at ${tt}.`;
  return '';
}

function socialCta() {
  const ig = config.haroldInstagram;
  const tt = config.haroldTikTok;
  if (ig && tt && ig === tt) return `He may respond on his Instagram and TikTok at ${ig}.`;
  if (ig && tt) return `He may respond on his Instagram at ${ig} and TikTok at ${tt}.`;
  if (ig) return `He may respond on his Instagram at ${ig}.`;
  if (tt) return `He may respond on his TikTok at ${tt}.`;
  return '';
}

config.confession.thankYouMessage = () => {
  const cta = socialCta();
  return `Thank you for calling Harold's Hotline. Harold will consider your confession.${cta ? ' ' + cta : ''} Now, time for another nap. Goodbye!`;
};

config.question.thankYouMessage = () => {
  const cta = socialCta();
  return `Thank you for calling Harold's Hotline. Harold will consider your situation.${cta ? ' ' + cta : ''} Goodbye!`;
};

config.speak.thankYouMessage = () => {
  const cta = socialCta();
  return `Thank you for calling Harold's Hotline. Harold was glad you called.${cta ? ' ' + cta : ''} Have a wonderful day!`;
};

config.speak.messageThankYouMessage = () => {
  const cta = socialCta();
  return `Thank you for leaving Harold a message. He will consider it when he is done napping.${cta ? ' ' + cta : ''} Have a wonderful day!`;
};

config.wisdom.thankYouMessage = () => {
  const follow = socialFollow();
  return `Harold hopes his wisdom serves you well.${follow ? ' ' + follow : ''} Have a wonderful day!`;
};

module.exports = config;
