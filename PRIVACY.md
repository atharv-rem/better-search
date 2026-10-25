# Better Search privacy policy

Last updated: 25 October 2026

Better Search is a file search for Windows, made by Atharv Remeshan. It works on your computer. There is no account, no analytics and no advertising, and the developer receives nothing from the app.

## What the app keeps on your computer

| What | Where | Why |
|---|---|---|
| An index of file and folder names, sizes and modified times for your NTFS drives (not file contents) | `%LOCALAPPDATA%\better-search\index.db` | So searches never scan your disk |
| How often and when you open results | In the same index | To rank files you open often higher |
| Your settings (shortcut, excluded drives and folders, search options) | The app's data folder | To remember your choices |
| Your recent searches | `recent.json` in the app's data folder | Listed under the empty search box. Turn this off in Settings and nothing is kept; the list can be cleared there too |
| Web search API keys you add | Windows Credential Manager | So web search can sign in to the provider you chose |
| Web search usage counts | `usage.json` in the app's data folder | To show your remaining credits |
| A log file | The app's log folder (Settings can open it) | To diagnose problems. It records app events, not your searches |

All of this stays on your computer. Uninstalling Better Search removes it when you tick "Delete the application data" in the uninstaller; the API keys are removed at the same time.

## Administrator access

Reading each drive's file list directly needs administrator rights. Better Search asks Windows for them (the UAC prompt) when it builds the index, and only a short-lived indexing program runs with them. It reads file and folder names, not what is inside your files. If you decline, the app still starts but can't index your drives.

## What leaves your computer

Only when you use web search, and only as follows:

- **Web search with an API key.** If you add a key for Exa, Firecrawl, TinyFish or Context.dev, the text you type is sent to that provider, with your key, to fetch results. It is not sent to anyone else, and nothing is sent until you add a key. The provider's own privacy policy applies to what it receives.
- **Result icons.** To show a site's icon beside a web result, the app asks that site directly for its favicon. The site can see your IP address, as with any request.
- **Search in your browser.** Choosing Google, Bing, DuckDuckGo, Brave Search or your own address opens that search in your default browser. Better Search sends nothing itself.
- **Updates.** The Microsoft Store delivers updates. The app doesn't contact any server to check for them.

You can remove an API key in Settings at any time, which stops sending queries to that provider.

## Children

Better Search isn't directed at children and doesn't knowingly collect anything from them.

## Changes

If the app starts to handle personal information differently, this policy will be updated first, and the date above will change.

## Contact

Atharv Remeshan, atharv.rem@gmail.com. Or open an issue at https://github.com/atharv-rem/better-search/issues.
