此文件只是占位：`packs/test/images/` 下按文件名约定放表现层资源，**读取层不校验图片**。
- 卡图：images/cards/<card_id>.png
- 技能图标：images/skills/<skill_id>.png
- **品阶卡框 / 技能框：images/frames/<frame>/card_frame.png 与 images/frames/<frame>/skill_frame.png**
  （`<frame>` = `rarities.yml` 里品阶项的 `frame`，**每个品阶一个文件夹、两个固定文件名**；
  卡框 = 600×300、**九宫格切片 24px**（四角不拉伸、**中间不画**）、不要内发光；
  技能框 = **96×96 圆形透明贴图**（只画环 / 材质），前端 `contain` 缩放；
  缺失则回落该品阶的 `color` 纯色，不阻塞）
- 角色头像：images/heroes/<hero_id>/avatar.png
- 角色立绘：images/heroes/<hero_id>/portraits/*.png
- ⚠️ **卡面没有 `frame` 字段**：卡框只由品阶决定
