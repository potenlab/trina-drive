// Unique mask ids for the inline logo mark (several marks render on one page; ids must not repeat).
let count = 0
export const nextMarkId = (): string => `tdm${++count}`
