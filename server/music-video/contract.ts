// Field names for recipe `anime-mv` on fraymus-video-studio (`studio serve`).
// Change them here if the studio contract moves; the routes talk to this module only.
export const ANIME_MV = {
  recipe: 'anime-mv',
  scriptKey: 'script',
  consentKey: 'consent',
  files: {
    song: 'song',
    songExt: 'song_ext',
    characterImage: 'character_image',
    characterImageExt: 'character_image_ext'
  },
  options: {
    character: 'character',
    storyline: 'storyline',
    style: 'style',
    aspect: 'aspect',
    lyrics: 'lyrics',
    backend: 'backend'
  },
  // Names the studio is expected to write. Classification also accepts close variants.
  outputs: {
    master: 'master.mp4',
    lyrics: 'lyrics.mp4',
    phone: 'phone.mp4',
    contact: 'qc-contact.png',
    shotlist: 'shotlist.md'
  }
} as const

export const OUTPUT_LABEL: Record<string, string> = {
  master: 'Clean master',
  lyrics: 'Lyrics master',
  phone: 'Phone copy',
  contact: 'QC contact sheet',
  shotlist: 'Shot list',
  other: 'File'
}

export function classifyOutput(name: string): 'master' | 'lyrics' | 'phone' | 'contact' | 'shotlist' | 'other' {
  const n = name.toLowerCase()
  if (n.includes('shotlist') || n.endsWith('.md')) return 'shotlist'
  if (n.includes('lyric')) return 'lyrics'
  if (n.includes('phone') || n.includes('9x16') || n.includes('vertical')) return 'phone'
  if (n.includes('contact') || n.includes('qc') || /\.(png|jpe?g|webp)$/.test(n)) return 'contact'
  if (n.includes('master') || n.includes('clean') || /\.(mp4|webm|mov)$/.test(n)) return 'master'
  return 'other'
}

export type MvInput = {
  title: string
  character: string
  storyline: string | string[]
  style: string
  aspect: '16:9' | '9:16'
  lyrics: boolean
  backend: 'hf' | 'comfy'
  songName: string
  characterImageName: string | null
}

export function storyText(storyline: string | string[]) {
  return Array.isArray(storyline) ? storyline.join('\n') : storyline
}

/** Body for POST /jobs. Keeps the studio's current {recipe, script, options, files, consent} shape. */
export function buildStudioBody(input: MvInput & { song: Buffer; songExt: string; image?: Buffer | null; imageExt?: string | null }) {
  const options: Record<string, unknown> = {
    [ANIME_MV.options.style]: input.style,
    [ANIME_MV.options.storyline]: input.storyline,
    [ANIME_MV.options.aspect]: input.aspect,
    [ANIME_MV.options.lyrics]: input.lyrics,
    [ANIME_MV.options.backend]: input.backend
  }
  if (input.character) options[ANIME_MV.options.character] = input.character
  const files: Record<string, string> = {
    [ANIME_MV.files.song]: input.song.toString('base64'),
    [ANIME_MV.files.songExt]: input.songExt
  }
  if (input.image?.length) {
    files[ANIME_MV.files.characterImage] = input.image.toString('base64')
    files[ANIME_MV.files.characterImageExt] = input.imageExt || '.png'
  }
  const body: Record<string, unknown> = {
    recipe: ANIME_MV.recipe,
    options,
    files,
    [ANIME_MV.consentKey]: true
  }
  if (ANIME_MV.scriptKey) body[ANIME_MV.scriptKey] = storyText(input.storyline)
  return body
}
