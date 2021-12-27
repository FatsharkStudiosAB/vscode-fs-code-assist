# Fatshark Code Assist

## Install
Available on the Visual Studio Code Marketplace: https://marketplace.visualstudio.com/items?itemName=Fatshark.fatshark-code-assist

Alternatively, if you're developing it you can also clone the repo into `%UserProfile%/.vscode/extensions`.

## Features
+ **Enhanced debugger:**
  + Attaches in <100ms instead of taking ~10 seconds (x100 fold improvement).
  + Execute Lua in the current lexical scope via the Debug Console.
  + Basic auto-complete in the debug console.
  + Expandable tree-view for table values. 
+ **Lua language features support:**
  + _Go to Definition_ (<kbd>F12</kbd>)
  + _Go to Symbol in Workspace_ (<kbd>Ctrl</kbd>+<kbd>T</kbd>)
  + _Go to Symbol in Editor_ (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>)
  + Dim code inside feature flags.
  + Color picker for color tables (eg, `{255,70,130,180}`).
  + Preview texture assets by hovering them.
  + (Basic) auto-completion on `self` methods.
+ **Other features:**
  + Recompile & refresh sources from within VSCode.
  + View console output (both compiler/games) within VSCode.
  + Clickable error links in the console output.

### Wishlist
+ Break on Uncaught Exceptions.
+ Fix folding for `IF_BEGIN` regions.
+ Task provider to compile/launch as a task.
+ Better code completion.

## License
See the [LICENSE](./LICENSE.txt) file.