export type SettingType = "number" | "integer" | "boolean" | "string";

export interface SettingDef {
  key: string;
  category: string;
  label: string;
  description: string;
  type: SettingType;
  default: number | boolean | string;
  min?: number;
  max?: number;
  /** Public settings are sent to game clients via /api/config. */
  public: boolean;
}
