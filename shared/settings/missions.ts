// Mission content and systems: cameras, turrets, hacking, alert states,
// reinforcements, civilians and package carrying. Everything the mission sim
// reads beyond the core squad/guard numbers lives here.
import type { SettingDef } from "./types";

export const MISSION_SETTINGS: SettingDef[] = [
  // --- Guard behaviour / alert states ---------------------------------------
  { key: "melee_range", category: "Alert & AI", label: "Takedown range", description: "Tiles. An agent this close to an unaware enemy performs a silent takedown.", type: "number", default: 1.25, min: 0.5, max: 3, public: true },
  { key: "detection_decay", category: "Alert & AI", label: "Detection decay rate", description: "Detection meter seconds drained per second once the agent is out of sight.", type: "number", default: 0.5, min: 0, max: 10, public: true },
  { key: "guard_wait_time", category: "Alert & AI", label: "Patrol pause", description: "Seconds a guard idles at each patrol waypoint.", type: "number", default: 1.5, min: 0, max: 30, public: true },
  { key: "guard_look_speed", category: "Alert & AI", label: "Look-around speed", description: "Radians per second a guard turns while idling or searching.", type: "number", default: 1.2, min: 0, max: 10, public: true },
  { key: "suspicious_search_time", category: "Alert & AI", label: "Suspicious search time", description: "Seconds a suspicious guard searches the last seen / noise position before calming down.", type: "number", default: 5, min: 0, max: 60, public: true },
  { key: "suspicious_detect_mul", category: "Alert & AI", label: "Suspicious detection multiplier", description: "How much faster an already-suspicious guard fills its detection meter.", type: "number", default: 1.5, min: 1, max: 10, public: true },
  { key: "noise_radius", category: "Alert & AI", label: "Gunfire noise radius", description: "Tiles. Calm guards within this radius of gunfire investigate; civilians panic.", type: "number", default: 9, min: 0, max: 40, public: true },
  { key: "target_hp", category: "Alert & AI", label: "Assassination target HP", description: "Hit points of the VIP in assassination contracts.", type: "integer", default: 40, min: 1, max: 1000, public: true },
  { key: "target_speed", category: "Alert & AI", label: "Assassination target speed", description: "Tiles per second.", type: "number", default: 1.2, min: 0.2, max: 10, public: true },

  // --- Reinforcements --------------------------------------------------------
  { key: "reinforcement_delay", category: "Reinforcements", label: "Reinforcement delay", description: "Seconds of continuous alarm before each reinforcement wave arrives at the map-edge spawn points.", type: "number", default: 25, min: 1, max: 600, public: true },
  { key: "reinforcement_count", category: "Reinforcements", label: "Guards per wave", description: "Guards spawned per reinforcement wave.", type: "integer", default: 3, min: 0, max: 20, public: true },
  { key: "reinforcement_waves", category: "Reinforcements", label: "Max waves", description: "Maximum number of reinforcement waves per mission.", type: "integer", default: 3, min: 0, max: 20, public: true },

  // --- Cameras ---------------------------------------------------------------
  { key: "camera_vision_range", category: "Cameras", label: "Camera vision range", description: "Tiles.", type: "number", default: 7, min: 1, max: 20, public: true },
  { key: "camera_fov", category: "Cameras", label: "Camera field of view", description: "Degrees.", type: "integer", default: 50, min: 5, max: 180, public: true },
  { key: "camera_sweep", category: "Cameras", label: "Camera sweep arc", description: "Degrees the camera pans across, centred on its mounting direction.", type: "integer", default: 100, min: 0, max: 360, public: true },
  { key: "camera_rotation_speed", category: "Cameras", label: "Camera rotation speed", description: "Peak pan speed in degrees per second.", type: "number", default: 35, min: 0, max: 360, public: true },
  { key: "camera_detection_time", category: "Cameras", label: "Camera detection time", description: "Seconds an agent must stay in a camera's view before it trips the alarm.", type: "number", default: 0.9, min: 0, max: 10, public: true },
  { key: "camera_hp", category: "Cameras", label: "Camera HP", description: "Damage needed to shoot a camera out. Gunfire still makes noise.", type: "integer", default: 15, min: 1, max: 500, public: true },

  // --- Turrets ---------------------------------------------------------------
  { key: "turret_range", category: "Turrets", label: "Turret range", description: "Tiles. Turrets only engage once the alarm is raised.", type: "number", default: 7, min: 1, max: 20, public: true },
  { key: "turret_damage", category: "Turrets", label: "Turret damage", description: "Damage per shot.", type: "integer", default: 7, min: 0, max: 500, public: true },
  { key: "turret_fire_cooldown", category: "Turrets", label: "Turret fire cooldown", description: "Seconds between shots.", type: "number", default: 0.45, min: 0.05, max: 10, public: true },
  { key: "turret_hp", category: "Turrets", label: "Turret HP", description: "Hit points of a turret.", type: "integer", default: 90, min: 1, max: 2000, public: true },

  // --- Hacking ---------------------------------------------------------------
  { key: "hack_time", category: "Hacking", label: "Terminal hack time", description: "Seconds an agent must stay next to a data or security terminal to hack it.", type: "number", default: 4, min: 0.1, max: 120, public: true },
  { key: "door_hack_time", category: "Hacking", label: "Door hack time", description: "Seconds to bypass a locked door.", type: "number", default: 2, min: 0.1, max: 120, public: true },
  { key: "hack_range", category: "Hacking", label: "Hack / interact range", description: "Tiles between an agent and the object it hacks or picks up.", type: "number", default: 1.6, min: 1, max: 4, public: true },
  { key: "decker_hack_mul", category: "Hacking", label: "Decker hack speed", description: "Hack speed multiplier for the Decker class.", type: "number", default: 1.75, min: 0.1, max: 10, public: true },
  { key: "alarm_hack_mul", category: "Hacking", label: "Alarm hack penalty", description: "Hack time multiplier once the alarm is raised (ICE goes hot).", type: "number", default: 2, min: 1, max: 10, public: true },
  { key: "security_hack_radius", category: "Hacking", label: "Security terminal radius", description: "Tiles. Hacking a security terminal disables every camera and turret within this radius.", type: "number", default: 14, min: 1, max: 60, public: true },

  // --- Civilians -------------------------------------------------------------
  { key: "civilian_count", category: "Civilians", label: "Civilians per mission", description: "Civilians spawned, spread over the mission's civilian markers (0 disables them).", type: "integer", default: 4, min: 0, max: 30, public: true },
  { key: "civilian_hp", category: "Civilians", label: "Civilian HP", description: "Hit points of a civilian.", type: "integer", default: 30, min: 1, max: 1000, public: true },
  { key: "civilian_speed", category: "Civilians", label: "Civilian speed", description: "Tiles per second while wandering.", type: "number", default: 1.1, min: 0.1, max: 10, public: true },
  { key: "civilian_panic_mul", category: "Civilians", label: "Civilian panic speed", description: "Speed multiplier while fleeing.", type: "number", default: 2, min: 1, max: 5, public: true },
  { key: "civilian_vision_range", category: "Civilians", label: "Civilian vision range", description: "Tiles at which a civilian notices a body or gunfire.", type: "number", default: 6, min: 0, max: 20, public: true },
  { key: "civilian_alarm_delay", category: "Civilians", label: "Civilian alarm delay", description: "Seconds a panicked civilian takes to reach a phone and raise the alarm.", type: "number", default: 4, min: 0, max: 60, public: true },
  { key: "civilian_wander_radius", category: "Civilians", label: "Civilian wander radius", description: "Tiles a civilian strays from where it spawned.", type: "number", default: 5, min: 1, max: 30, public: true },

  // --- Research theft --------------------------------------------------------
  { key: "carry_speed_mul", category: "Research theft", label: "Carry speed", description: "Speed multiplier for an agent carrying a prototype or scientist.", type: "number", default: 0.6, min: 0.1, max: 1, public: true },
];
