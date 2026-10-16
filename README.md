# Assist 3.2.2

Made with Claude and Codex.


Windows desktop overlay based on `ui-test.html`. It keeps forum text locally, sends relevant excerpts to an OpenAI-compatible chat API, can read public forum pages, and keeps a searchable conversation history.

## Run

1. Install [Node.js LTS](https://nodejs.org/) if `node --version` and `npm --version` do not work.
2. Open PowerShell in this folder and run:

   ```powershell
   npm install
   npm start
   ```

3. Press **Ctrl+Shift+A** to show or hide the overlay. Change the shortcut in **Настройки**. Close exits the app; Minimize hides it to the taskbar, and the shortcut restores it.
4. In **Настройки**, enter the provider's API key, model ID, and endpoint. Click **Проверить API** to check it. Google Gemini accepts its native endpoint, such as `https://generativelanguage.googleapis.com/v1beta` with model `gemini-flash-latest`, or a full model endpoint ending in `:generateContent`. OpenAI-compatible services use a base URL such as `https://api.deepseek.com/v1`; the app appends `/chat/completions`. Yandex AI Studio uses `https://ai.api.cloud.yandex.net/v1`, API key without a prefix, and model URI `gpt://<folder_ID>/<model_ID>/latest` (e.g. `gpt://<folder_ID>/yandexgpt/latest`). The app uses Yandex Chat Completions; assign the service account `ai.models.user` or `ai.languageModels.user` and give the API key the `yc.ai.languageModels.execute` scope. The `ai.assistants.editor` role is not required for this text-generation endpoint.
5. In **База знаний**, add a public forum thread URL, paste forum text, or import an HTML file. HTML auto mode extracts text locally; AI mode cleans it using the configured model. Sources remain searchable offline. Then ask in Russian or English.

API keys, source text, settings, and history are saved in Electron's per-user application data folder (`%APPDATA%\assist-overlay\assist-data.json`) as ordinary local JSON. Protect that Windows account and remove the file if you want to erase local data.

## Voice and fallback

There is no voice output. In **Голос**, choose microphone, computer audio, or both; refresh devices and select a microphone/headphones. Choosing headphones also makes them the Windows default output device. The app captures that system output with Electron's Windows loopback, mixes it with the selected microphone, and transcribes short speech segments through the configured provider. A question is sent to chat automatically after a pause; unrelated speech is discarded. Yandex uses SpeechKit for transcription and needs role `ai.speechkit-stt.user` plus API-key scope `yc.ai.speechkitStt.execute`; Gemini and audio-capable OpenAI chat models use their own audio endpoints.

If there is no API/network, the app returns matching saved-source excerpts and never invents an answer. That is an offline fallback, not a local AI model. For generated offline answers, run a local OpenAI-compatible model server and enter its local endpoint and model name. Web fallback is attempted only for clearly phrased questions, and only search results with matching terms are sent to the model. Web search uses DuckDuckGo HTML results; it can be unavailable or rate-limited. For reliable offline answers, paste the forum text into the knowledge base. The optional Windows offline voice recognizer does not use an API, but on this computer it is available only for English; no Russian offline speech model is installed.

## Provider compatibility

Chat supports native Gemini `generateContent`, OpenAI `chat/completions`, and OpenAI `responses` endpoints. Chat generation has no fixed application timeout: it continues until the provider responds or you press **Стоп**. The API check can also be cancelled while it is running. A successful API check does not act as a keep-alive, so the local model server must be configured not to unload the model if you need it to stay warm. Voice transcription supports Gemini `generateContent`, an audio-capable OpenAI-compatible chat model, or Yandex SpeechKit. A text-only local model cannot transcribe audio; select **Yandex SpeechKit отдельно** in voice settings to keep local chat and use SpeechKit for transcription. Keys stay on this computer and are sent only to the endpoint you configure.
