/**
 * Prompt → Story (kịch bản nhiều ngôn ngữ) bằng DeepSeek. Story được kiểm tra với Registry; nếu sai
 * (id nhân vật/bối cảnh không có, thiếu bản dịch…) thì gửi lỗi lại cho AI sửa, tối đa MAX_REPAIRS lần.
 */
import { EMOTIONS } from "../../src/schemas/scene.schema";
import { findAsset } from "../../src/schemas/asset.schema";
import { castable, characterStyle, checkStory, type CheckOptions, type RequestedCharacter, GESTURES, LANGUAGES, MAX_LINES, MAX_SCENES, MOODS, supportedGestures, VOICE_ROLES, type Lang, type Story, type StoryIssue } from "../../src/ai/story";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Registry } from "../../src/schemas/asset.schema";
import { AiError, chatJson, type ChatMessage } from "./deepseek";
import { availableObjectKinds, OBJECT_KINDS } from "../../src/ai/objects";

const MAX_REPAIRS = 2;
const ENV_DIR = join(resolve(import.meta.dirname, "../.."), "environments");

/** Mô tả bối cảnh lấy từ environments/*.layout.json (Registry chỉ có tên). */
function envDescriptions(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const f of readdirSync(ENV_DIR).filter((f) => f.endsWith(".layout.json"))) {
      const l = JSON.parse(readFileSync(join(ENV_DIR, f), "utf8")) as { id?: string; description?: string };
      if (l.id && l.description) out[l.id] = l.description;
    }
  } catch {
    /* không có thư mục → chỉ dùng tên */
  }
  return out;
}

export interface GenerateOptions {
  prompt: string;
  languages: Lang[];
  /** Độ dài mong muốn (giây), gợi ý số câu thoại. */
  seconds?: number;
  /** Số khung cảnh mong muốn; undefined = AI tự chọn theo câu chuyện. */
  scenes?: number;
  /** Mức chi tiết của cốt truyện (mật độ câu thoại + yêu cầu tiểu tiết). Mặc định "normal". */
  detail?: StoryDetail;
  /** Nhân vật người dùng chọn: AI phải dùng đúng những nhân vật này. Bỏ trống = AI tự chọn. */
  cast?: RequestedCharacter[];
}

export const STORY_DETAILS = ["short", "normal", "detailed"] as const;
export type StoryDetail = (typeof STORY_DETAILS)[number];

/** Số giây trung bình cho một câu thoại theo mức chi tiết (càng chi tiết càng nhiều câu ngắn, thoại qua lại). */
const SECONDS_PER_LINE: Record<StoryDetail, number> = { short: 4, normal: 3.2, detailed: 2.7 };
/** Trần số câu mỗi cảnh (schema cho phép 20) – chừa chỗ cho AI. */
const LINES_PER_SCENE = 18;

const DETAIL_HINT: Record<StoryDetail, string> = {
  short: "Keep the plot simple and short: a clear setup, one problem, a quick resolution and the lesson.",
  normal:
    "Give the story real substance: show WHY characters do what they do, let them react to each other, and include at least one small complication before the problem is solved.",
  detailed:
    "Write a RICH, DETAILED story – not a summary. Include: a setup that shows the characters' everyday life and personalities; a concrete reason for the problem; at least one failed attempt or wrong choice before the right one; a moment of hesitation or inner conflict where the hero thinks out loud; reactions of the other characters (questions, worries, jokes, encouragement); small sensory details about the place and time (sounds, weather, objects around them); a clear climax; and a warm ending where the characters say what they learned in their own words. Each beat should take several back-and-forth lines, not one.",
};

export interface GenerateResult {
  story: Story;
  model: string;
  attempts: number;
  tokens: number;
}

function catalog(registry: Registry): string {
  const chars = castable(registry)
    .map((a) => `${a.id} | ${a.name} | ${characterStyle(a)} | ${a.height ?? "?"}m | tags: ${a.tags.filter((t) => t !== "character").join(",")} | gestures: ${supportedGestures(registry, a.id).join(",") || "-"}`)
    .join("\n");
  const desc = envDescriptions();
  const envs = registry.assets
    .filter((a) => a.type === "environment")
    .map((a) => `${a.id} | ${a.name}${desc[a.id] ? ` – ${desc[a.id]}` : ""}`)
    .join("\n");
  const objects = availableObjectKinds(registry)
    .map((k) => `${k} | ${OBJECT_KINDS[k]!.label}`)
    .join("\n");
  return `AVAILABLE ENVIRONMENTS (id | name – description):\n${envs}\n\nAVAILABLE CHARACTERS (id | name | style | height | tags | gestures it can perform):\n${chars}\n\nAVAILABLE OBJECT KINDS (kind | what it is):\n${objects}`;
}

function systemPrompt(registry: Registry, languages: Lang[]): string {
  const langList = languages.map((l) => `"${l}" (${LANGUAGES[l].english})`).join(", ");
  return `You are a screenwriter for short 3D cartoon videos for children. The video is made of one or more SCENES: each scene takes place in its own location (environment), the characters present stand together there and talk, and scenes are joined with a transition. The engine handles camera and positions automatically.

Write the story and return ONLY a JSON object with this exact shape:
{
  "languages": [${languages.map((l) => `"${l}"`).join(", ")}],
  "title":   { <lang>: string },
  "summary": { <lang>: string },            // 1-2 sentences
  "music": true,
  "mood": ${MOODS.map((m) => `"${m}"`).join(" | ")},  // overall feeling → background music
  "narratorVoice": "female" | "deep" | "low" | "child" | "squeaky",
  "ending": "dance" | "wave" | "none",      // what everyone does on the last line
  "characters": [                           // 1 to 6: everyone who appears anywhere in the story
    { "id": "<short snake_case id>", "asset": "<character id>", "voice": "${VOICE_ROLES.join('" | "')}", "name": { <lang>: string }, "size": "small" | "normal" | "big" }
  ],
  "objects": [                              // 0 to 6 things characters pick up, carry, give or put down
    { "id": "<short snake_case id>", "kind": "<object kind>", "name": { <lang>: string },
      "scene": "<scene id where it lies at the start>" | null, "heldBy": "<character id holding it from the start>" | null }
  ],
  "scenes": [                              // 1 to ${MAX_SCENES}, in story order
    {
      "id": "<short snake_case id, e.g. farm, forest_path>",
      "environment": "<environment id>",
      "cast": ["<character id from characters>"],       // 1 to 5 characters present in THIS scene
      "transition": "fade" | "dissolve" | "cut",        // how we enter this scene (ignored for the first)
      "time": null | "day" | "morning" | "sunset" | "night",   // time of day of this scene (night = moonlight + fireflies)
      "mood": null | <mood>,                            // only when this scene feels different (e.g. "sad" when lost, "magic" at the discovery)
      "entrance": null | "walk" | "speaker" | "none",   // who walks into frame as the scene opens (null = automatic)
      "lines": [                            // dialogue of this scene, in order
        { "id": "l1", "speaker": "<character id from this scene's cast>" | null, "gesture": ${GESTURES.map((g) => `"${g}"`).join(" | ")} | null, "text": { <lang>: string },
          "emotion": ${EMOTIONS.map((e) => `"${e}"`).join(" | ")},
          "action": null | { "type": "pickup" | "give" | "drop" | "stow" | "trip", "object": "<object id>", "to": "<receiver id, for give>" | null, "by": "<actor id if the speaker is the narrator>" | null },
          "to": null | "<id of the character this line is said to>",
          "interaction": null | { "type": "hug" | "highfive" | "pat" | "walk" | "leave" | "play", "with": "<other character id>" | null, "by": "<actor id if the speaker is the narrator>" | null },
          "then": null | "return" | "stay" | "leave",   // only with an action/interaction: where the actor goes AFTER the line
          "vocal": null | "laugh" | "gasp" | "sigh" | "hmm" | "wow" | "ouch" | "yay" }   // non-verbal sound right before the line
      ]
    }
  ]
}

Rules:
- Every localized object ("title", "summary", "name", "text") MUST contain ALL of these languages: ${langList}. Each language version is a natural, idiomatic adaptation of the same story (not a word-by-word translation); keep the same meaning and the same line order.
- "environment" and "asset" MUST be ids copied exactly from the lists below. Pick characters that fit the story and the environments.
- All characters MUST share the same "style" (all "cube" or all "lowpoly") so they look like they belong in the same cartoon. Family members of the same kind of animal use the SAME asset: the parent gets "size": "big", a baby "small" (e.g. mom fox = same fox asset with size big). Adults vs kids for humans: pick taller adult assets for parents.
- Scenes: use several scenes when the story travels or changes place (e.g. home → forest → river), each with a DIFFERENT environment that fits what happens there. Keep a single scene when the whole story happens in one place. Each scene has 6–14 lines (never more than 20) and moves the story forward with its own small beginning, middle and end; the first line of a new scene should make the change of place clear (often the narrator).
- "mood" picks the background music: happy, calm (gentle, bedtime), adventure (journey, quest), sad (lost, missing someone), magic (wonder, discovery), playful (jokes, games). Set a scene "mood" only when the feeling clearly changes; otherwise null.
- "transition": "fade" for a journey or a change of time, "dissolve" for a gentle change of place, "cut" for an immediate jump.
- "entrance": "speaker" when the first speaker arrives at this place (e.g. the hero reaching the meadow), "walk" only when the whole group arrives together, "none" when everyone is already there (continuing a conversation, waking up, a scene inside the same place). Use null to let the engine choose (first scene: the first speaker walks in; later scenes: everyone already there). Do NOT make every scene start with someone walking in.
- The same character keeps the same "id", asset and voice in every scene. A speaker MUST be in that scene's "cast". Line "id"s are unique across the whole story (l1, l2, l3… continuing across scenes).
- "speaker": null means the narrator. Use the narrator for the opening or the closing lesson if helpful.
- Pick "gesture" only from the gestures that character can perform (listed below), otherwise null. Beyond wave / yes / no / thumbsup / clap / dance / victory / defeat / jump, some characters can also laugh, cry, shrug (not sure / "who knows?"), think (wondering), point (showing something), bow (greeting politely, thanks), cheer, blow_kiss (love, goodbye) and salute – use them when they fit the line. Without a gesture the engine already adds talking body language that matches the emotion.
- "emotion" is how the speaker feels on that line (the character acts it out and the voice follows): use it to make feelings visible – sad when lost or sorry, surprised at a discovery, scared of danger, angry only mildly, happy when celebrating; "neutral" otherwise. Vary emotions across the story.
- Voice roles (prefer the gentle ones for a children's cartoon): soft = gentle warm female (mom, teacher, narrator), cute = sweet little kid (girl or small child), warm = kind male (dad, grandpa), child = older kid / boy, squeaky = tiny animal, low = young man, deep = big / old / scary character, female = plain female (news-like). Give different characters different voices when possible. "narratorVoice" should usually be "soft".
- Each line is one or two short sentences a child can follow (max ~25 words) – keep lines short, and make the story detailed by adding MORE lines and beats, not longer lines. Friendly, positive, age-appropriate. End with a clear, simple lesson.
- Hit the requested number of lines: do not stop early. Dialogue is a real conversation – characters ask questions, answer, disagree gently, joke, react with feelings ("Oh no!", "Really?") – instead of each saying one statement. The narrator may add short descriptive details between dialogue (what the place looks like, what time it is, what a character is thinking).
- Objects make the story visible: when a character finds, collects, carries or gives something (a flower for mom, litter to clean up, a mushroom, a gift…), declare it in "objects" and show it with "action" on a line instead of only talking about it. Use "kind" only from the list below.
- "action" is performed right BEFORE its line is spoken, by the speaker (or "by" when the narrator speaks): "pickup" = walk to the object lying in THIS scene, pick it up and bring it back; "give" = walk to "to" (in this scene's cast) and hand over an object the actor is holding; "drop" = put a held object down. Write the line as what the character says right after doing it (e.g. after pickup: "What a beautiful flower!"). At most one action per line.
- More object actions: "stow" = carry an object the actor is holding to the toy box and put it inside (tidying up; the engine places the toy box; pick the object up first); "trip" = the actor runs and trips over an object LYING in this scene, falls and gets up (a consequence of a mess – follow it with a sad/scared line and someone comforting them).
- "to": who the speaker is talking to (they turn toward them). Set it when it is not simply the next speaker (e.g. talking to someone who does not answer); otherwise null.
- "interaction" makes characters physically interact instead of only standing and talking – use 1–3 per scene when it fits the moment: "hug" (comfort, thanks, reunion, love), "highfive" (success, agreement, teamwork), "pat" (encourage or comfort a friend) are performed right BEFORE the line, by the speaker (or "by") toward "with" (another character in this scene's cast; required). "leave" = the speaker walks out of the scene together with "with" (or with everyone when "with" is null) while saying the line – ONLY on the last line of a scene, e.g. "Let's go to the meadow!". A line has either "action" or "interaction", not both. Write the line as what the character says right after (after a hug: "Thank you, mom!").
- "play" = the speaker runs a happy lap and jumps for joy right BEFORE the line ("with" = another character chasing them, or null): use it for playing, excitement, celebrating.
- "walk" = the speaker walks over to "with" (required) and stands next to them right BEFORE the line – to join someone, go and talk quietly, check on a friend, come closer to look at something together. The speaker stays there afterwards (a new place to stand).
- "vocal" = a short non-verbal sound the speaker makes right BEFORE the line (not written in "text", no subtitle): "laugh" (giggle at a joke / while playing), "gasp" (sudden surprise or fright), "sigh" (sad, tired, disappointed), "hmm" (thinking, unsure), "wow" (amazed), "ouch" (after tripping or bumping), "yay" (cheering). Use it at emotional peaks only – about 1–3 per story, never on narrator lines, and do not repeat the same sound in "text".
- "then" decides where the actor of an "action"/"interaction" goes AFTER the line – choose it from the story, do not always go back: "stay" = stays right where they are now (e.g. after a hug the child stays beside mom; after picking a flower they stay by the flower bed and keep talking there; after "walk" they stay next to the friend); "return" = walks back to their previous place (e.g. after handing something over and going back to what they were doing); "leave" = walks out of the scene after the line (e.g. mom gives the snack and goes back to the kitchen; a visitor says goodbye) – a character who leaves must NOT speak, act or be addressed again in that scene. null = automatic ("walk" stays, others return). Mix them so characters move around the place naturally instead of snapping back to the same spot.
- SHOW, DON'T TELL: this is an animated video, so the plot must be visible. Every scene needs several actions/interactions (typically 3–6 for a 8–12 line scene), and every turning point of the story should be acted out, not only said: e.g. a messy room → toys lying around ("objects" in the scene); ignoring advice → "play"; the consequence → "trip"; comfort → "hug"/"pat"; making up for it → "pickup" + "stow" / "give"; success → "highfive"; leaving → "leave". Build a clear arc: setup → problem → consequence → feelings → making it right → warm ending + lesson. Characters should talk TO each other (reply, ask, react) rather than make speeches.
- A held object stays with its holder into later scenes (e.g. pick a flower in the meadow, give it to mom at the farm). An object must be lying in a scene to be picked up there, and must be held by the actor to be given or dropped. A character holds ONE object at a time: to pick up something else, first "drop" or "give" what they hold.
- Character, scene, object and line "id": lowercase letters, digits, underscore only.

${catalog(registry)}`;
}

function parseJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AiError("AI trả về JSON không hợp lệ");
  }
}

function describeIssues(issues: StoryIssue[]): string {
  return issues.map((i) => `- ${i.path}: ${i.message}`).join("\n");
}

async function converse(registry: Registry, messages: ChatMessage[], opts: CheckOptions = { strictStyle: true }): Promise<GenerateResult> {
  let tokens = 0;
  let model = "";
  let last: StoryIssue[] = [];
  for (let attempt = 1; attempt <= MAX_REPAIRS + 1; attempt++) {
    const res = await chatJson(messages);
    tokens += res.usage?.total_tokens ?? 0;
    model = res.model;
    const raw = parseJson(res.content);
    const { story, issues } = checkStory(raw, registry, opts);
    if (story) return { story, model, attempts: attempt, tokens };
    last = issues;
    messages.push(
      { role: "assistant", content: res.content },
      { role: "user", content: `The JSON has these problems. Fix them and return the full corrected JSON object:\n${describeIssues(issues)}` },
    );
  }
  throw new AiError(`AI chưa sửa được kịch bản sau ${MAX_REPAIRS + 1} lần:\n${describeIssues(last).slice(0, 1500)}`);
}

export function generateStory(registry: Registry, o: GenerateOptions): Promise<GenerateResult> {
  const seconds = o.seconds ?? 45;
  const detail = o.detail ?? "normal";
  const scenes = o.scenes ? Math.max(1, Math.min(MAX_SCENES, Math.round(o.scenes))) : undefined;
  // Mỗi cảnh thêm ~4s mở đầu (nhân vật đi vào) → bớt câu thoại khi nhiều cảnh.
  const cap = Math.min(MAX_LINES - 2, scenes ? scenes * LINES_PER_SCENE : MAX_LINES - 2);
  const lines = Math.max(4, Math.min(cap, Math.round((seconds - 4 * ((scenes ?? 1) - 1)) / SECONDS_PER_LINE[detail])));
  const sceneHint = scenes
    ? scenes === 1
      ? "Use exactly 1 scene (one location)."
      : `Use exactly ${scenes} scenes, each in a different environment.`
    : `Choose the number of scenes (1–4) that fits the story${lines > LINES_PER_SCENE ? ` – with ~${lines} lines you need at least ${Math.ceil(lines / LINES_PER_SCENE)} scenes (max 20 lines per scene)` : ""}.`;
  const cast = o.cast?.length ? o.cast : undefined;
  return converse(
    registry,
    [
      { role: "system", content: systemPrompt(registry, o.languages) },
      { role: "user", content: `Story request:\n${o.prompt.trim()}\n\nTarget length: about ${seconds} seconds (~${lines} lines in total – write at least ${Math.round(lines * 0.9)}). ${sceneHint}
${DETAIL_HINT[detail]}${cast ? castHint(registry, cast) : ""}` },
    ],
    // Người dùng tự chọn nhân vật → không ép cùng phong cách.
    { strictStyle: !cast, cast },
  );
}

/** Yêu cầu dùng đúng các nhân vật người dùng đã chọn. */
function castHint(registry: Registry, cast: readonly RequestedCharacter[]): string {
  const list = cast
    .map((c, i) => {
      const a = findAsset(registry, c.asset);
      return `${i + 1}. asset "${c.asset}" (${a?.name ?? c.asset})${c.name ? ` – name / role: "${c.name}"` : " – you choose the name"}`;
    })
    .join("\n");
  return `\n\nThe reviewer has chosen the characters. Use EXACTLY these characters, each exactly once in "characters" (the same asset listed twice means two different characters), and NO other characters (the narrator is fine):\n${list}\nUse the given name / role (translated naturally into every language). Choose fitting voices and sizes. The art-style rule does not apply to chosen characters. Give every chosen character something to say or do.`;
}

/** Sửa kịch bản theo góp ý của người duyệt (và/hoặc thêm ngôn ngữ). */
export function reviseStory(registry: Registry, story: Story, instruction: string, languages: Lang[] = story.languages, strictStyle = true): Promise<GenerateResult> {
  const note = instruction.trim() || "Keep the story as is.";
  return converse(registry, [
    { role: "system", content: systemPrompt(registry, languages) },
    {
      role: "user",
      content: `Here is the current story JSON:\n${JSON.stringify({ ...story, languages })}\n\nRevise it according to this feedback from the reviewer (the feedback may be in Vietnamese):\n${note}\n\nThe result must contain these languages: ${languages.join(", ")}. Keep everything the feedback does not ask to change (including the character assets). Return the full JSON object.`,
    },
  ], { strictStyle });
}
