import { describe, expect, it } from 'vitest'
import { dedupeBlanketName } from '../src/services/memory/blanket.js'

describe('dedupeBlanketName 同名被子加序号', () => {
  it('没有重名就用原名（第一份不加序号）', () => {
    expect(dedupeBlanketName('柔光核心讨论方案', [])).toBe('柔光核心讨论方案')
    expect(dedupeBlanketName('柔光核心讨论方案', ['别的被子'])).toBe('柔光核心讨论方案')
  })

  it('重名一次加（2）', () => {
    expect(dedupeBlanketName('柔光', ['柔光'])).toBe('柔光（2）')
  })

  it('连续重名顺着（3）（4）往下排', () => {
    expect(dedupeBlanketName('柔光', ['柔光', '柔光（2）'])).toBe('柔光（3）')
    expect(dedupeBlanketName('柔光', ['柔光', '柔光（2）', '柔光（3）'])).toBe('柔光（4）')
  })

  it('中间空档也能接上：删了（2）留下（3），新被子补（2）', () => {
    expect(dedupeBlanketName('柔光', ['柔光', '柔光（3）'])).toBe('柔光（2）')
  })

  it('半角括号不算重名（用户自己写的（2）是另一个名字）', () => {
    expect(dedupeBlanketName('柔光', ['柔光(2)'])).toBe('柔光')
  })

  it('带序号的基名也能继续排：原图就有"柔光（2）"时', () => {
    expect(dedupeBlanketName('柔光（2）', ['柔光（2）', '柔光'])).toBe('柔光（2）（2）')
  })
})
