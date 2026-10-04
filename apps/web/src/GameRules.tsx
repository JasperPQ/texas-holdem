import { useState } from "react";

function GameRules() {
  const [open, setOpen] = useState(false);

  return (
    <section className={open ? "game-rules open" : "game-rules"}>
      <button
        className="game-rules-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="game-rules-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">✦</span> 游戏规则
        <i aria-hidden="true">{open ? "收起 ▴" : "展开 ▾"}</i>
      </button>

      {open && (
        <div className="game-rules-panel" id="game-rules-panel">
          <div className="game-rules-block">
            <h3>目标</h3>
            <p>所有人同样的筹码起步，输光筹码即出局；打到只剩一人有筹码时，他赢得比赛。</p>
            <h3>一手牌</h3>
            <p>小盲、大盲下注后，每人发 <b>2 张底牌</b>；依次经过翻牌前、翻牌（3 张公共牌）、转牌、河牌四轮下注，最后摊牌比大小。</p>
          </div>

          <div className="game-rules-block">
            <h3>下注</h3>
            <ul>
              <li>可以弃牌、过牌、跟注、下注 / 加注，或全下。</li>
              <li>最小下注一个大盲；加注至少要加上一次加注的幅度。</li>
              <li>无人跟的超额下注会退回；有人全下时另开边池。</li>
              <li>限时内未操作：能过牌则自动过牌，否则自动弃牌。</li>
            </ul>
          </div>

          <div className="game-rules-block">
            <h3>牌型（大 → 小）</h3>
            <p>同花顺 · 四条 · 葫芦 · 同花 · 顺子 · 三条 · 两对 · 一对 · 高牌</p>
            <p className="game-rules-note">用 2 张底牌和 5 张公共牌中任意 5 张组成最大的牌型；A 在顺子里可以当 1。</p>
          </div>
        </div>
      )}
    </section>
  );
}

export default GameRules;
