import { describe, expect, it } from 'vitest'
import { collapsedLatestScrollTop } from './chatHistoryLayout'

describe('collapsedLatestScrollTop', () => {
  it('短消息继续交给浏览器钳制到底部', () => {
    expect(collapsedLatestScrollTop({
      scrollHeight: 900,
      currentScrollTop: 300,
      listTop: 100,
      itemTop: 500,
      itemHeight: 120,
      viewportHeight: 220,
    })).toBe(900)
  })

  it('长消息定位到最新消息顶部，而不是底部', () => {
    expect(collapsedLatestScrollTop({
      scrollHeight: 900,
      currentScrollTop: 300,
      listTop: 100,
      itemTop: 250,
      itemHeight: 444,
      viewportHeight: 220,
    })).toBe(450)
  })

  it('长消息顶部目标不会越过最大可滚动位置', () => {
    expect(collapsedLatestScrollTop({
      scrollHeight: 900,
      currentScrollTop: 300,
      listTop: 100,
      itemTop: 800,
      itemHeight: 444,
      viewportHeight: 220,
    })).toBe(680)
  })
})
