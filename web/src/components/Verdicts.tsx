import { Alert, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import type { AsrResult } from '../types';
import type { ContrastVerdict } from '../lib/asr';

/**
 * 降级路径（vosk 二选一）的结果。**只在边车连不上时才走这条。**
 *
 * ── 为什么单独一个文件 ──
 *
 * 它原来长在 Recorder.tsx 里、不导出，于是**一条测试都没有**——三个测试文件都把
 * contrastAll 打桩成返回 `[]`，这段渲染从来没执行过。而边车连不上正是这个应用
 * 第一号故障（启动时那个窗口被关掉），它恰恰是那时候唯一还能给结论的一屏。
 *
 * PhonemeResult 当初为同一个理由被导出：「导出只是为了能测它」。同一笔账。
 *
 * 两条硬规矩，四个分支都得守（Verdicts.test.tsx 盯着）：
 *   · **自报家门**——词表二选一只能在给定的两个词里挑一个，说不出第三种可能。
 *     把它的结论当成音素级诊断会误导人。
 *   · **不许用红**——theme.ts：「红色只留给真正的破坏性操作」。念错了不是破坏性操作，
 *     主路径（套印带）里发错的音就是用第二版油墨画的，这条路得跟它一致。
 */
export default function Verdicts({ target, verdicts, diff, why }: {
  target: string;
  verdicts: ContrastVerdict[];
  /** 输掉的那条换回来的笔记链接；没有输掉的就是 null */
  diff: AsrResult | null;
  /** 为什么退到了这条路（边车报的原因），四个分支都要如实带上 */
  why: string;
}) {

  if (verdicts.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message="这个词没有可比的对立音"
        description={
          <>
            {why}，只能退到弱办法——而它靠的是拿你的录音跟"只差一个音的另一个词"比。
            {'现在的笔记里没有哪条说过这个词里的音容易跟什么混，所以配不出这样一对词。'}
            {'给相关的音写一篇笔记，这里就会自动出现对比。'}
          </>
        }
      />
    );
  }

  const lost = verdicts.filter((v) => v.winner === 'partner');
  const unclear = verdicts.filter((v) => v.winner === null);
  const won = verdicts.filter((v) => v.winner === 'target');

  // 降级路径必须自报家门。词表二选一只能在给定的两个词里挑一个，说不出第三种可能——
  // 把它的结论当成音素级诊断会误导人。
  //
  // **这里不给"怎么修好"的办法。** 原来写的是「在仓库根目录跑 `npm run asr`」，
  // 而同一屏上方 Recorder 正说着「装完重新双击启动那个文件即可 / 不叫人去翻终端——
  // 双击启动的人可能根本没有那个窗口」。同一个问题两条相反的指示，
  // 而且这一条对普通用户是错的：`npm start` 本来就带着边车，缺的多半是 uv，
  // 单跑 `npm run asr` 一样起不来。怎么开只由 Recorder 说，那儿说得对也说得全。
  const banner = (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 8 }}
      message="这次是弱办法：只能在两个词里挑一个"
      description={
        <>
          {why}。这条路只能回答"在这两个词里你更像哪个"，<strong>说不出你实际发的是什么音</strong>。
        </>
      }
    />
  );

  const rows = (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {verdicts.map((v) => (
        <Space key={`${v.index}-${v.word}`} size={6} wrap>
          {/* 念成了对立词**不上红**。theme.ts：「刻意不用红色报错……"对/错"是评判，
              红色只留给真正的破坏性操作」。主路径（套印带）里发错的音就是用第二版油墨
              画的，这条降级路径得跟它一致，不能自己另立一套配色。 */}
          <Tag color={v.winner === 'target' ? 'success' : v.winner === 'partner' ? 'processing' : undefined}>
            第 {v.index + 1} 个音
          </Tag>
          <Typography.Text>
            /{v.targetIpa}/ <Typography.Text type="secondary">对</Typography.Text> /{v.partnerIpa}/
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            （{target} / {v.word}）
          </Typography.Text>
          {v.winner === 'target' && <Typography.Text type="success">✓ 听成 /{v.targetIpa}/</Typography.Text>}
          {/* 同样不上红：这是发音判决。用第二版油墨——主路径里"你发的音"就是这个颜色 */}
          {v.winner === 'partner' && (
            <Typography.Text style={{ color: 'var(--blue)' }}>✗ 听成 /{v.partnerIpa}/</Typography.Text>
          )}
          {v.winner === null && <Typography.Text type="warning">两个都不像，没听清</Typography.Text>}
          {v.conf !== null && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{Math.round(v.conf * 100)}%</Typography.Text>
          )}
        </Space>
      ))}
    </Space>
  );

  {/* 「撞上**已知短板**」是被拆掉的那个 severity 留下的最后一处。
      笔记挂上来只说明"有一篇讲这个音的"，不说明它是这个人的短板——
      仓库自带的那几篇是上一个使用者练出来的。判定短板的活在服务端
      （profile.ts 的 severityOf，按他自己的评测记录），不由这里断言。 */}
  const noteLinks = diff && diff.notes.length > 0 && (
    <Space direction="vertical" size={2}>
      {diff.notes.map((n) => (
        <div key={n.id}><Link to={`/notes/${n.id}`}>这个音有讲解：{n.title}</Link></div>
      ))}
    </Space>
  );

  if (lost.length > 0) {
    return (
      <Alert
        // 同上：这是发音判断，不是破坏性操作，也不是系统故障。用 warning（琥珀＝提醒）。
        type="warning"
        showIcon
        message={`第 ${lost.map((v) => v.index + 1).join('、')} 个音发成了对立音`}
        description={
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {banner}
            {rows}
            <span>
              识别器在二选一里选了对面那个词——这就是具体错在哪个音。先单独练这个音，
              {'再放回整词。'}
            </span>
            {noteLinks}
          </Space>
        }
      />
    );
  }

  if (unclear.length === verdicts.length) {
    return (
      <Alert
        type="warning"
        showIcon
        message="没听清"
        description={
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {banner}
            {rows}
            <span>两个候选都不像，可能音量太小、有噪音，或者念得离这两个词都远。再录一次。</span>
          </Space>
        }
      />
    );
  }

  return (
    <Alert
      type="success"
      showIcon
      message={`${won.length} 个音都跟对立音分得开`}
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {banner}
          {rows}
          <Typography.Text type="secondary">
            分得开不等于发音标准——它只说明这几组对立你没混。音色、时长、重音这些
            {'这个弱办法测不出来，那部分还得靠 A/B 对比自己听。'}
          </Typography.Text>
        </Space>
      }
    />
  );
}
