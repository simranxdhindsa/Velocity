// Slack sends emoji as :name: codes. This turns the common ones into real emoji so messages look
// the way they do in Slack. A code that is not listed (a custom workspace emoji, for example) stays
// as plain text. Format: name|alias=emoji, separated by spaces.
const EMOJI = `
smile=😄 smiley=😃 grinning=😀 grin=😁 laughing|satisfied=😆 sweat_smile=😅 joy=😂 rolling_on_the_floor_laughing|rofl=🤣
slightly_smiling_face|simple_smile=🙂 upside_down_face=🙃 wink=😉 blush=😊 innocent=😇 relaxed=☺️ yum=😋 relieved=😌
heart_eyes=😍 smiling_face_with_3_hearts=🥰 kissing_heart=😘 star-struck|star_struck=🤩 partying_face=🥳 sunglasses=😎 nerd_face=🤓
face_with_monocle=🧐 thinking_face|thinking=🤔 face_with_raised_eyebrow=🤨 hugging_face|hugs=🤗 shushing_face=🤫 zipper_mouth_face=🤐
saluting_face=🫡 melting_face=🫠 neutral_face=😐 expressionless=😑 no_mouth=😶 smirk=😏 unamused=😒 face_with_rolling_eyes|roll_eyes=🙄
grimacing=😬 lying_face=🤥 pensive=😔 sleepy=😪 sleeping=😴 yawning_face=🥱 tired_face=😫 weary=😩 confused=😕 worried=😟
slightly_frowning_face=🙁 white_frowning_face|frowning_face=☹️ open_mouth=😮 astonished=😲 flushed=😳 pleading_face=🥺 disappointed=😞
cry=😢 sob=😭 scream=😱 fearful=😨 cold_sweat=😰 sweat=😓 exploding_head=🤯 dizzy_face=😵 rage=😡 angry=😠 triumph=😤
smiling_imp=😈 skull=💀 ghost=👻 alien=👽 robot_face|robot=🤖 clown_face=🤡 hankey|poop|shit=💩 see_no_evil=🙈 hear_no_evil=🙉 speak_no_evil=🙊
wave=👋 raised_hand|hand=✋ ok_hand=👌 +1|thumbsup=👍 -1|thumbsdown=👎 clap=👏 raised_hands=🙌 pray=🙏 handshake=🤝 muscle=💪 fist=✊
facepunch|punch=👊 v=✌️ crossed_fingers|hand_with_index_and_middle_fingers_crossed=🤞 metal=🤘 call_me_hand=🤙 writing_hand=✍️
point_up=☝️ point_up_2=👆 point_down=👇 point_left=👈 point_right=👉 eyes=👀 brain=🧠 speech_balloon=💬 thought_balloon=💭
shrug|person_shrugging=🤷 man-shrugging|man_shrugging=🤷‍♂️ woman-shrugging|woman_shrugging=🤷‍♀️
face_palm|facepalm=🤦 man-facepalming|man_facepalming=🤦‍♂️ woman-facepalming|woman_facepalming=🤦‍♀️
heart=❤️ orange_heart=🧡 yellow_heart=💛 green_heart=💚 blue_heart=💙 purple_heart=💜 black_heart=🖤 white_heart=🤍
broken_heart=💔 two_hearts=💕 sparkling_heart=💖 heartpulse=💗 heartbeat=💓
fire=🔥 rocket=🚀 tada=🎉 confetti_ball=🎊 sparkles=✨ star=⭐ star2=🌟 zap=⚡ boom|collision=💥 100=💯 dart=🎯 trophy=🏆 crown=👑 gem=💎
first_place_medal=🥇 second_place_medal=🥈 third_place_medal=🥉 medal|sports_medal=🏅 checkered_flag=🏁 triangular_flag_on_post=🚩
white_check_mark=✅ heavy_check_mark=✔️ ballot_box_with_check=☑️ x=❌ negative_squared_cross_mark=❎ heavy_multiplication_x=✖️
warning=⚠️ rotating_light=🚨 no_entry=⛔ no_entry_sign=🚫 octagonal_sign=🛑 construction=🚧 question=❓ grey_question=❔
exclamation|heavy_exclamation_mark=❗ grey_exclamation=❕ bangbang=‼️ interrobang=⁉️ information_source=ℹ️ bulb=💡
red_circle=🔴 large_orange_circle=🟠 large_yellow_circle=🟡 large_green_circle=🟢 large_blue_circle=🔵 large_purple_circle=🟣
white_circle=⚪ black_circle=⚫ ok=🆗 new=🆕 cool=🆒 sos=🆘 free=🆓 up=🆙
arrow_right=➡️ arrow_left=⬅️ arrow_up=⬆️ arrow_down=⬇️ arrows_counterclockwise=🔄 repeat=🔁 recycle=♻️ heavy_plus_sign=➕ heavy_minus_sign=➖
memo|pencil=📝 pencil2=✏️ clipboard=📋 bookmark=🔖 pushpin=📌 round_pushpin=📍 paperclip=📎 link=🔗 mag=🔍 mag_right=🔎
calendar=📆 date=📅 spiral_calendar_pad|spiral_calendar=🗓️ alarm_clock=⏰ stopwatch=⏱️ hourglass=⌛ hourglass_flowing_sand=⏳ clock=🕐 clock1=🕐
bell=🔔 no_bell=🔕 mega=📣 loudspeaker=📢 email|envelope=✉️ incoming_envelope=📨 inbox_tray=📥 outbox_tray=📤 package=📦
chart_with_upwards_trend=📈 chart_with_downwards_trend=📉 bar_chart=📊 file_folder=📁 open_file_folder=📂 page_facing_up=📄 books=📚 book=📖
newspaper=📰 lock=🔒 unlock=🔓 key=🔑 bug=🐛 gear=⚙️ wrench=🔧 hammer=🔨 hammer_and_wrench=🛠️ nut_and_bolt=🔩 shield=🛡️ test_tube=🧪
computer=💻 desktop_computer=🖥️ keyboard=⌨️ iphone=📱 phone|telephone=☎️ camera=📷 video_camera=📹 tv=📺 headphones=🎧 microphone=🎤
musical_note=🎵 notes=🎶 art=🎨 moneybag=💰 dollar=💵 money_with_wings=💸 credit_card=💳 gift=🎁 balloon=🎈 birthday=🎂 cake=🍰
coffee=☕ tea=🍵 beer=🍺 beers=🍻 pizza=🍕 hamburger=🍔 sunny=☀️ sun_with_face=🌞 cloud=☁️ umbrella=☔ snowflake=❄️ rainbow=🌈
crescent_moon=🌙 earth_asia=🌏 earth_americas=🌎 earth_africa=🌍 globe_with_meridians=🌐 airplane=✈️ car=🚗 taxi=🚕 house=🏠 office=🏢
dog=🐶 cat=🐱 monkey=🐒 unicorn_face=🦄 turtle=🐢 snail=🐌 tophat=🎩 seedling=🌱 herb=🌿 four_leaf_clover=🍀
`

const MAP = new Map<string, string>()
for (const entry of EMOJI.split(/\s+/)) {
  const at = entry.lastIndexOf('=')
  if (at > 0) for (const name of entry.slice(0, at).split('|')) MAP.set(name, entry.slice(at + 1))
}

const SKIN_TONES: Record<string, string> = { '2': '🏻', '3': '🏼', '4': '🏽', '5': '🏾', '6': '🏿' }

/** Replaces known :name: codes (with an optional :skin-tone-N:) with real emoji. */
export function slackEmojify(text: string): string {
  return text.replace(/(?<![\w/]):([a-z0-9_+-]+):(?::skin-tone-([2-6]):)?/g, (match, name: string, tone?: string) => {
    const emoji = MAP.get(name)
    if (!emoji) return match
    return tone ? emoji.replace('️', '') + SKIN_TONES[tone] : emoji
  })
}
