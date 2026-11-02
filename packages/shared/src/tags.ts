export const normalizeTag = (t: string) => {
  const s = t.trim().toUpperCase().replace(/O/g, "0");
  return s.startsWith("#") ? s : `#${s}`;
};
export const encodeTag = (t: string) => encodeURIComponent(normalizeTag(t));
