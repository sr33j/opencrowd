export interface InputEdit {
  value: string;
  cursor: number;
}

export function insertInputText(value: string, cursor: number, text: string): InputEdit {
  const normalized = text.replace(/\r\n?/g, "\n");
  return {
    value: value.slice(0, cursor) + normalized + value.slice(cursor),
    cursor: cursor + normalized.length
  };
}
