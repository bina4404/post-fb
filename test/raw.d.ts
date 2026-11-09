// Vite/Vitest: import "file?raw" trả về nội dung file dạng chuỗi.
declare module "*?raw" {
  const content: string;
  export default content;
}
