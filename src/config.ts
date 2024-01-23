export default class Config {
  static isCompressionEnabled = process.env.INIBASE_COMPRESSION === "true";
  static isCacheEnabled = process.env.INIBASE_CACHE === "true";
  static isReverseEnabled = process.env.INIBASE_REVERSE === "true";
}
