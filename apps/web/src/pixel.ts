import { createContext, useContext } from "react";

/**
 * 当前是不是像素版画面。牌等少数组件在两种画面下的标记不同（像素版用像素牌面图，不叠加放大角标），
 * 用 context 传下去；原始版本那一支的标记和改版前完全相同。
 */
export const PixelContext = createContext(false);

export function usePixel(): boolean {
  return useContext(PixelContext);
}
