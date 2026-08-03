import { Button } from 'antd';
import PageResult from './PageResult';

/**
 * 连不上服务时的那一屏。
 *
 * **它跟「库里没有这个词」必须是两屏。** 原来所有失败都走同一个空状态，于是服务一停，
 * 每个词条页都说「库里还没有这个词」，还请你回首页去建——而首页同样连不上。
 * 一个本地工具最常见的故障（启动的那个窗口被关掉了），界面给的是一条走不通的路。
 *
 * 这里给的是**真的能走通的那一步**：重新双击启动那个文件。
 * 不说「稍后重试」——等多久都不会自己好，服务不会自己起来。
 *
 * 三个系统的文件名都列出来，因为这一屏出现时用户多半正手足无措，
 * 让他再去翻文档找自己该点哪个，等于把他推开。
 */
export default function Offline() {
  return (
    <PageResult
      slug="连不上"
      title="连不上正音的服务"
      extra={<Button type="primary" onClick={() => window.location.reload()}>刷新这一页</Button>}
    >
      它多半已经停了——启动时弹出的那个窗口关掉，服务就跟着停。
      <br />
      回项目文件夹双击 <b>启动.cmd</b>（Windows）/ <b>启动.command</b>（macOS）/
      {' '}<b>启动.sh</b>（Linux），起来之后刷新这一页。
    </PageResult>
  );
}
