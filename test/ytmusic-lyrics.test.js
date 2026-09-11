/**
 * ytmusic-lyrics.test.js
 * YouTube Music 的歌詞是整段放在一個文字節點裡,須自行拆成逐句。
 *
 * 只測拆解與曲目判定這兩個純函式 —— 插入頁面要有瀏覽器,不在這一層測。
 * 測資的換行與空行形態取自實測(2026-09)。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitLyricsText, nowPlayingFrom, isYouTubeMusic } from '../src/content/ytmusic-lyrics.js';

const texts = (lines) => lines.map((l) => l.text);

test('依換行拆成逐句', () => {
  const lines = splitLyricsText('沈むように溶けてゆくように\n二人だけの空が広がる夜に');
  assert.deepEqual(texts(lines), ['沈むように溶けてゆくように', '二人だけの空が広がる夜に']);
});

test('\\r\\n 換行不殘留 \\r', () => {
  /*
   * LyricFind 的曲目(Lemon、紅蓮華)實測為 \r\n。
   * 殘留的 \r 看不見,卻會進入手動切分的 key 與送去轉換的文字。
   */
  const lines = splitLyricsText('夢ならばどれほどよかったでしょう\r\n未だにあなたのことを夢にみる\r\n');
  assert.deepEqual(texts(lines), ['夢ならばどれほどよかったでしょう', '未だにあなたのことを夢にみる']);
  assert.ok(lines.every((l) => !l.text.includes('\r')));
});

test('單獨的 \\r 也視為換行', () => {
  assert.deepEqual(texts(splitLyricsText('一\r二')), ['一', '二']);
});

test('空行不成為一句,而是標記下一句為段落開頭', () => {
  const lines = splitLyricsText('二人だけの空が広がる夜に\n\n「さよなら」だけだった\nその一言で全てが分かった');
  assert.deepEqual(texts(lines), ['二人だけの空が広がる夜に', '「さよなら」だけだった', 'その一言で全てが分かった']);
  assert.deepEqual(
    lines.map((l) => l.paragraphStart),
    [false, true, false]
  );
});

test('\\r\\n 的空行同樣算段落', () => {
  const lines = splitLyricsText('強くなれる理由を知った 僕を連れて進め\r\n\r\n泥だらけの走馬灯に酔う');
  assert.deepEqual(
    lines.map((l) => l.paragraphStart),
    [false, true]
  );
});

test('連續多個空行只算一次段落', () => {
  const lines = splitLyricsText('一\n\n\n\n二');
  assert.deepEqual(texts(lines), ['一', '二']);
  assert.equal(lines[1].paragraphStart, true);
});

test('開頭與結尾的空行略過,第一句不標為段落開頭', () => {
  // 第一句之前沒有上一段,標記它只會在歌詞頂端多出一段空白
  const lines = splitLyricsText('\n\n一\n二\n\n');
  assert.deepEqual(texts(lines), ['一', '二']);
  assert.equal(lines[0].paragraphStart, false);
});

test('去除每句前後空白(含全形空格),句中空格保留', () => {
  const lines = splitLyricsText('  強くなれる理由を知った 僕を連れて進め　');
  assert.deepEqual(texts(lines), ['強くなれる理由を知った 僕を連れて進め']);
});

test('空字串、只有空白、null 皆回傳空陣列', () => {
  assert.deepEqual(splitLyricsText(''), []);
  assert.deepEqual(splitLyricsText('\n \r\n　\n'), []);
  assert.deepEqual(splitLyricsText(null), []);
});

test('曲目:歌手取 channel 連結,略過專輯連結', () => {
  const info = nowPlayingFrom({
    title: ' 群青 ',
    links: [
      { text: 'YOASOBI', href: 'channel/UCI6B8NkZKqlFWoiC_xE-hzA' },
      { text: 'THE BOOK', href: 'browse/MPREb_hqiB0KumHYT' },
    ],
  });
  assert.deepEqual(info, { trackName: '群青', artistName: 'YOASOBI' });
});

test('曲目:專輯排在前面時仍取到歌手', () => {
  const info = nowPlayingFrom({
    title: '群青',
    links: [
      { text: 'THE BOOK', href: 'browse/MPREb_hqiB0KumHYT' },
      { text: 'YOASOBI', href: '/channel/UCI6B8NkZKqlFWoiC_xE-hzA' },
    ],
  });
  assert.equal(info.artistName, 'YOASOBI');
});

test('曲目:廣告(沒有歌手連結)不算一首歌', () => {
  // 實測:廣告播放時標題為廣告名稱,byline 沒有任何連結
  assert.equal(nowPlayingFrom({ title: 'Uber Eats', links: [] }), null);
  assert.equal(
    nowPlayingFrom({ title: 'Uber Eats', links: [{ text: 'Uber Eats', href: 'browse/xyz' }] }),
    null
  );
});

test('曲目:缺標題即回傳 null', () => {
  assert.equal(nowPlayingFrom({ title: '', links: [{ text: 'YOASOBI', href: 'channel/x' }] }), null);
  assert.equal(nowPlayingFrom({ links: [{ text: 'YOASOBI', href: 'channel/x' }] }), null);
});

test('只認 music.youtube.com,一般 YouTube 與 Spotify 不算', () => {
  assert.equal(isYouTubeMusic('music.youtube.com'), true);
  assert.equal(isYouTubeMusic('www.youtube.com'), false);
  assert.equal(isYouTubeMusic('open.spotify.com'), false);
});
