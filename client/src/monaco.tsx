/// <reference types="vite/client" />
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/go/register';
import { useEffect, useRef } from 'react';
import { monacoTheme, useTheme } from './theme';

// Only the two judge languages, highlighted locally; no CDN and no language servers.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco: monaco as never });

export default function CodeEditor(props: {
  language: 'python' | 'javascript' | 'c' | 'cpp' | 'java' | 'go';
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
  onSubmit?: () => void;
}) {
  const theme = useTheme();
  const themeName = `cc-${theme.id}`;
  monaco.editor.defineTheme(themeName, monacoTheme(theme));
  const submit = useRef(props.onSubmit);
  submit.current = props.onSubmit;

  useEffect(() => { monaco.editor.setTheme(themeName); }, [themeName]);

  const mount: OnMount = (editor) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => submit.current?.());
  };

  return (
    <Editor
      height={props.height ?? '360px'}
      language={props.language}
      value={props.value}
      onChange={(value) => props.onChange(value ?? '')}
      onMount={mount}
      theme={themeName}
      options={{
        readOnly: props.readOnly,
        minimap: { enabled: false },
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 14,
        lineHeight: 22,
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        tabSize: 4,
        automaticLayout: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        overviewRulerLanes: 0,
      }}
    />
  );
}
