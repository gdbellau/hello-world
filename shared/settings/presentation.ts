// Presentation: graphics, lighting, audio defaults.
// All public: the client renderer reads them from `sim.cfg`, and the audio
// module uses the volume defaults until the player changes them locally.
import type { SettingDef } from "./types";

export const PRESENTATION_SETTINGS: SettingDef[] = [
  // --- Graphics ------------------------------------------------------------
  { key: "graphics_quality", category: "Presentation", label: "Graphics quality", description: "0 = low (no glow, particles or post FX), 1 = medium, 2 = high (rain, dust, full bloom).", type: "integer", default: 2, min: 0, max: 2, public: true },
  { key: "ambient_light", category: "Presentation", label: "Ambient light", description: "Base light level baked into floors and walls (0 = pitch black, 1 = flat lit).", type: "number", default: 0.4, min: 0, max: 1, public: true },
  { key: "neon_density", category: "Presentation", label: "Neon sign density", description: "Chance (0-1) that an exposed wall face carries a sign, ad or window.", type: "number", default: 0.35, min: 0, max: 1, public: true },
  { key: "rain_enabled", category: "Presentation", label: "Rain", description: "Screen-space rain streaks and splashes (high quality only).", type: "boolean", default: true, public: true },
  { key: "rain_density", category: "Presentation", label: "Rain density", description: "Rain streaks on screen at once.", type: "integer", default: 140, min: 0, max: 1000, public: true },
  { key: "scanlines_enabled", category: "Presentation", label: "Scanlines", description: "CRT scanline and vignette overlay (medium quality and up).", type: "boolean", default: true, public: true },
  { key: "screen_shake", category: "Presentation", label: "Screen shake", description: "Multiplier for camera shake on gunfire, alarms and explosions (0 disables).", type: "number", default: 1, min: 0, max: 3, public: true },
  { key: "wall_cutaway_alpha", category: "Presentation", label: "Wall cut-away opacity", description: "Opacity of walls that stand in front of a unit.", type: "number", default: 0.3, min: 0.05, max: 1, public: true },
  { key: "max_particles", category: "Presentation", label: "Max particles", description: "Particle cap at high quality (medium uses half).", type: "integer", default: 400, min: 0, max: 3000, public: true },

  // --- Audio ---------------------------------------------------------------
  { key: "default_master_volume", category: "Audio", label: "Default master volume", description: "0-1. Players can override locally.", type: "number", default: 0.8, min: 0, max: 1, public: true },
  { key: "default_music_volume", category: "Audio", label: "Default music volume", description: "0-1. Players can override locally.", type: "number", default: 0.45, min: 0, max: 1, public: true },
  { key: "default_sfx_volume", category: "Audio", label: "Default SFX volume", description: "0-1. Players can override locally.", type: "number", default: 0.8, min: 0, max: 1, public: true },
  { key: "music_enabled", category: "Audio", label: "Music enabled", description: "Global switch for the procedural soundtrack.", type: "boolean", default: true, public: true },
  { key: "music_crossfade_s", category: "Audio", label: "Music crossfade (s)", description: "Seconds to crossfade between music tracks.", type: "number", default: 2, min: 0, max: 10, public: true },
];
