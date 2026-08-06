import { useRef, useState } from 'react';
import { Button, Card, Space, Typography, message } from 'antd';
import { api } from '../api';

/**
 * 搬家：把练习记录导出成一个文件，或者从别的机器灌回来。
 *
 * ── 为什么需要 ──
 *
 * 发布之后，一个人的数据散在三处：`notes/`（跟着 git 走，全用户共享）、
 * `data/users/<当前用户>/` 下的 `发音档案.md` 和 `review-state.json`、
 * 以及同一目录下的 `index.db`（词条和每一次录音的判定）。后两类都本机、已 gitignore。
 * 换台电脑没有任何一键搬家的办法，而后两样**丢了就没有**——
 * 那是几十次录音攒出来的判定，不是重下一遍音频能补回来的。
 *
 * ── 只带不可再生的 ──
 *
 * 备份里没有音频（54 个 mp3，重查一次词典就有）也没有参考转写（同理）。
 * 塞进去会让文件从几十 KB 变成几十 MB，而换回来的只是省一次下载。
 *
 * ── 导入是「合并」，不是「覆盖」 ──
 *
 * 同一次录音（同词条 + 同时间戳）已经在库里就跳过；复习进度**本机那张赢**。
 * 典型场景是"换了台电脑想把两边合起来"，而本机的进度是刚练出来的，
 * 灌一份旧备份不该把它推回去。所以这个按钮不需要吓人的确认——它加不减。
 *
 * 下面那句「它只加不减」一度是**假的**：词条走的是无条件覆盖，对面那份直接盖掉本机的。
 * 普通词无所谓（两边都是词典算的），坏在**手工音标**上——词典查不到的词，
 * 音标是人一个字一个字敲的，对面没敲过就是空串，一次合并就抹掉了。
 * 服务端（db.ts 的 importBackup）现在跟复习进度同一条规矩：谁有手工音标听谁的，
 * 都有或都没有就本机赢。这句话才重新变成真的。
 */
export default function BackupSetting() {
  const [busy, setBusy] = useState<null | 'out' | 'in'>(null);
  const file = useRef<HTMLInputElement>(null);

  async function exportIt() {
    setBusy('out');
    try {
      const data = await api.exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `正音备份-${data.exportedAt.slice(0, 10)}.json`;
      a.click();
      // 造出去的 blob URL 必须撤掉，否则每导一次就漏一份内存到页面关闭为止
      URL.revokeObjectURL(url);
      message.success('已导出');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败');
    } finally {
      setBusy(null);
    }
  }

  async function importIt(f: File) {
    setBusy('in');
    try {
      const r = await api.importBackup(JSON.parse(await f.text()) as unknown);
      message.success(`并入 ${r.added} 次录音、${r.cards} 张复习卡；${r.skipped} 次本机已有，跳过`);
      // 统计、复习、发音档案全变了。整页重载最省事，也不会留下半新半旧的界面
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导入失败');
    } finally {
      setBusy(null);
      if (file.current) file.current.value = '';
    }
  }

  return (
    <Card title="搬家" size="small">
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Typography.Text type="secondary" className="measure" style={{ fontSize: 13 }}>
          导出<strong>当前用户</strong>查过哪些词和每一次录音的判定，外加复习进度。
          {'想搬另一个人的，先在左边切过去再导。'}
          {'换电脑时导进去就接着练。音频和音标不在里面——那些重查一次词典就有，'}
          {'带上只会把文件撑到几十 MB。'}
        </Typography.Text>

        <Space wrap>
          <Button onClick={() => void exportIt()} loading={busy === 'out'}>导出备份</Button>
          <Button onClick={() => file.current?.click()} loading={busy === 'in'}>导入备份</Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importIt(f);
            }}
          />
        </Space>

        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          导入是<strong>合并</strong>：同一次录音已经在库里就跳过，复习进度以本机的为准。
          {'它只加不减，所以不会覆盖你现在的记录。'}
          <br />
          <strong>笔记不在备份里</strong>——那些在 <Typography.Text code>notes/</Typography.Text> 目录里，
          {'跟着这个文件夹走——整个文件夹拷过去就带上了。'}
        </Typography.Text>
      </Space>
    </Card>
  );
}
