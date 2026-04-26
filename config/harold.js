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

  // Harold's socials
  haroldInstagram: process.env.HAROLD_INSTAGRAM || null,

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

  greeting:
    "Hello caller, thank you for calling Harold's Hotline. " +
    'Press 1 to leave a confession for Harold. ' +
    'Press 2 to speak to Harold directly.',

  noInputMessage:
    "We didn't catch your selection. Thank you for calling Harold's Hotline. Goodbye!",

  // Confession flow
  confession: {
    holdMessage:
      "Please hold for Harold to come to the phone. He's just finishing a nap.",
    recordingPrompt:
      'Please leave your confession for Harold. When you are finished, press 1.',
    thankYouMessage: (instagram) =>
      "Thank you for calling Harold's Hotline. He may respond to your confessional" +
      (instagram ? ` on his Instagram, ${instagram}` : '') +
      '. Now, time for another nap. Goodbye!',
  },

  // Speak-to-Harold flow
  speak: {
    // Shown before hold music + Harold audio
    introExcuses: [
      "Please hold while Harold comes to the phone. He's currently waking up from a nap.",
      "Please hold while Harold comes to the phone. He's chasing a chipmunk and will be right with you.",
      "Please hold while Harold comes to the phone. He's currently sitting in a paper bag.",
      "Please hold while Harold comes to the phone. He's staring intensely at the wall and needs a moment.",
      "Please hold while Harold comes to the phone. He's knocking items off the counter and will be right there.",
      "Please hold while Harold comes to the phone. He's loafing in a sunbeam and it may take a minute.",
      "Please hold while Harold comes to the phone. He's conducting an important investigation behind the couch.",
    ],
    // Shown after Harold audio ends — explain why he had to go
    exitExcuses: [
      "Harold unfortunately had to return to his nap. He hopes you understand.",
      "Harold has been called away by the sound of a treat bag. He sends his regards.",
      "Harold spotted a suspicious bird through the window and had to investigate immediately.",
      "Harold had an urgent appointment with the sunny spot on the rug. He apologizes for the inconvenience.",
      "Harold received an emergency alert that his food bowl was thirty percent empty. He had to respond.",
      "Harold was called back to his post monitoring the front door for the mailman.",
      "It appears Harold has fallen back asleep mid-conversation. Classic Harold.",
    ],
    thankYouMessage:
      "Thank you so much for calling Harold's Hotline. Have a wonderful day!",
  },
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

config.pickIntroExcuse = () => pickRandom(config.speak.introExcuses);
config.pickExitExcuse = () => pickRandom(config.speak.exitExcuses);

module.exports = config;
