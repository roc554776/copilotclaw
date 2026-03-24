# Multi-Channel (raw requirement)

- channel を複数にして会話を別々に進行できるようにする
- dashboard は、channel が 1 つしかない。複数タブで増やせるようにする
  - channel は固有の channel id を持つ
- user input の post や get は channel id ごとにキューが分かれる（API の修正が必要）
- channel 追加や list も API 経由でできるようにする
- インメモリで動かしている都合もあってデフォルトで 1 つ最初から起動時に作っておく
- agent は起動時に channel ID を割り当てる
  - channel の queue に未処理の user input があって、かつその channel に対応する agent がなければ、agent を起動する（ひとまず子として起動する。ゾンビ化すると面倒なので）
- これにより agent を直接起動するフローは基本的になくなる
- agent の user input fetch について、同じチャンネルに未処理の user input が複数あったら一括で fetch する（チャットなので、複数のメッセージを連続で送られて、それらを全部読んでから返すのが普通）
