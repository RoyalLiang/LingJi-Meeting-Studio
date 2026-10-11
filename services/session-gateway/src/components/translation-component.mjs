import { shouldTranslate } from "@tts/domain";

export class TranslationComponent {
  #dictionaries = {
    "zh-CN": {
      hello: "你好",
      roadmap: "路线图",
      action: "行动项",
      meeting: "会议",
      transcript: "转录",
      translation: "翻译",
      customer: "客户",
      launch: "上线",
      summary: "摘要"
    }
  };

  mockTranslate(text, targetLanguage) {
    const dictionary = this.#dictionaries[targetLanguage];
    if (!dictionary) {
      return `[${targetLanguage}] ${text}`;
    }

    const translated = text
      .split(/\s+/)
      .map((token) => {
        const normalized = token.toLowerCase().replace(/[^a-z-]/g, "");
        return dictionary[normalized] ?? token;
      })
      .join(" ");

    return `[${targetLanguage}] ${translated}`;
  }

  translate(text, targetLanguage, sourceLanguage = "en", options = {}) {
    if (!shouldTranslate(sourceLanguage, targetLanguage, options)) {
      return null;
    }
    return this.mockTranslate(text, targetLanguage);
  }
}
