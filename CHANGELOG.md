# Changelog

## [0.2.0](https://github.com/KinjiKawaguchi/scrum-harness/compare/v0.1.0...v0.2.0) (2026-11-28)


### Features

* **activity:** log items added, Status changes, and pull requests opened and merged ([#65](https://github.com/KinjiKawaguchi/scrum-harness/issues/65)) ([6ee786c](https://github.com/KinjiKawaguchi/scrum-harness/commit/6ee786c86dda79890f58aa58b35d0daa741a44fa))
* **activity:** log the messages the team's sessions send, without their bodies ([#64](https://github.com/KinjiKawaguchi/scrum-harness/issues/64)) ([634ad06](https://github.com/KinjiKawaguchi/scrum-harness/commit/634ad06b2748bc1b8df3cfa0d006e2b9d9334329))
* **adapters:** check a board module without writing to the tracker ([#60](https://github.com/KinjiKawaguchi/scrum-harness/issues/60)) ([687e3e6](https://github.com/KinjiKawaguchi/scrum-harness/commit/687e3e63ab9aa7cd90de16e797e5549a78444450))
* **adapters:** read the board from a program that speaks scrum-board/1 ([#71](https://github.com/KinjiKawaguchi/scrum-harness/issues/71)) ([00e5753](https://github.com/KinjiKawaguchi/scrum-harness/commit/00e575374d1362c2bcdc4a44163bcbc32802d439))
* **adapters:** write the board through a program, by its capabilities ([#72](https://github.com/KinjiKawaguchi/scrum-harness/issues/72)) ([7fd04d0](https://github.com/KinjiKawaguchi/scrum-harness/commit/7fd04d0619f3b98a75472d4816c223ed0acdbbc7))
* **agency-runtime:** answer participantMetrics, and add scrum metrics ([#103](https://github.com/KinjiKawaguchi/scrum-harness/issues/103)) ([5c1bf38](https://github.com/KinjiKawaguchi/scrum-harness/commit/5c1bf38cceb72b6ec7a97d77af898925596a9a13)), closes [#102](https://github.com/KinjiKawaguchi/scrum-harness/issues/102)
* **agency-runtime:** count the time a member waits for the owner's answer as waiting ([#116](https://github.com/KinjiKawaguchi/scrum-harness/issues/116)) ([b1ce32b](https://github.com/KinjiKawaguchi/scrum-harness/commit/b1ce32b00a4359369217aacb1e15f968ab32bbcf)), closes [#106](https://github.com/KinjiKawaguchi/scrum-harness/issues/106)
* **board:** read a shared board once for the teams of a machine, and say what the read cost ([#144](https://github.com/KinjiKawaguchi/scrum-harness/issues/144)) ([29d8b1b](https://github.com/KinjiKawaguchi/scrum-harness/commit/29d8b1b54aec9ae601e60cfa4c85fcf1dc01aefd)), closes [#142](https://github.com/KinjiKawaguchi/scrum-harness/issues/142)
* **budget:** hold back new work and ask the owner when the weekly budget is used ([#92](https://github.com/KinjiKawaguchi/scrum-harness/issues/92)) ([f0022ff](https://github.com/KinjiKawaguchi/scrum-harness/commit/f0022ff4040977e81c998400461f3a7359cfb24e)), closes [#89](https://github.com/KinjiKawaguchi/scrum-harness/issues/89)
* **budget:** start members on a cheaper model at the weekly budget's warning, and not at all when it is used ([#90](https://github.com/KinjiKawaguchi/scrum-harness/issues/90)) ([c0e8fc2](https://github.com/KinjiKawaguchi/scrum-harness/commit/c0e8fc220e1aaa772ab8aa15d0e370b177a14553)), closes [#89](https://github.com/KinjiKawaguchi/scrum-harness/issues/89)
* **forecast:** scrum forecast, when the ready work finishes and how many people it can use ([#143](https://github.com/KinjiKawaguchi/scrum-harness/issues/143)) ([6f0a291](https://github.com/KinjiKawaguchi/scrum-harness/commit/6f0a291e1b9c4c542ce4848db2bfc3fde00c0d11))
* **github:** hold back reads and back off when GitHub's GraphQL limit is near, and count the harness's own use ([#155](https://github.com/KinjiKawaguchi/scrum-harness/issues/155)) ([b7c964b](https://github.com/KinjiKawaguchi/scrum-harness/commit/b7c964b8b6a38382f668c323e1af8ea5e5f61157))
* **members:** adopt running members and start a stopped one with --resume ([#87](https://github.com/KinjiKawaguchi/scrum-harness/issues/87)) ([5fb45ba](https://github.com/KinjiKawaguchi/scrum-harness/commit/5fb45ba37f2253a5d57e7fcb7c04d073c7aac345))
* **members:** answer Claude Code's question about trusting a member's folder ([#112](https://github.com/KinjiKawaguchi/scrum-harness/issues/112)) ([dffaf9e](https://github.com/KinjiKawaguchi/scrum-harness/commit/dffaf9ef044082ab9ac02e22ba84b0018b4e40d9))
* **members:** let the lead put an idle member on standby so T-IDLE stops flagging it ([#146](https://github.com/KinjiKawaguchi/scrum-harness/issues/146)) ([7d2ea90](https://github.com/KinjiKawaguchi/scrum-harness/commit/7d2ea900d53bb84cccebf85305b5d7f451627b39)), closes [#145](https://github.com/KinjiKawaguchi/scrum-harness/issues/145)
* **members:** move an idle member automatically when its source passes its threshold ([#88](https://github.com/KinjiKawaguchi/scrum-harness/issues/88)) ([e16ed1f](https://github.com/KinjiKawaguchi/scrum-harness/commit/e16ed1fc06c15b7e4d1769b54f81121f7d62b2e9))
* **members:** move an idle member to the account the node picks ([#86](https://github.com/KinjiKawaguchi/scrum-harness/issues/86)) ([14b229a](https://github.com/KinjiKawaguchi/scrum-harness/commit/14b229ac037e7832a664df8afff6c4920c249095))
* **members:** never let a member keep running on a subscription past its threshold ([#138](https://github.com/KinjiKawaguchi/scrum-harness/issues/138)) ([fa78fae](https://github.com/KinjiKawaguchi/scrum-harness/commit/fa78faeff57b84200b398e97349179e5252275ab))
* **members:** read the sessions of every login the node funds ([#85](https://github.com/KinjiKawaguchi/scrum-harness/issues/85)) ([4a40051](https://github.com/KinjiKawaguchi/scrum-harness/commit/4a400514ac11c86eef4f2a21e4234af68a89e176))
* **members:** report a member that is stuck on an API error ([#94](https://github.com/KinjiKawaguchi/scrum-harness/issues/94)) ([3862296](https://github.com/KinjiKawaguchi/scrum-harness/commit/386229669fdb3a459d642f7c99b3ce9d84abfc00)), closes [#81](https://github.com/KinjiKawaguchi/scrum-harness/issues/81)
* **members:** show in member list that a running member waits at a trust question ([#119](https://github.com/KinjiKawaguchi/scrum-harness/issues/119)) ([074e16e](https://github.com/KinjiKawaguchi/scrum-harness/commit/074e16e093232bd9cd1c6750415fab86869cf4e7)), closes [#113](https://github.com/KinjiKawaguchi/scrum-harness/issues/113)
* **members:** start a member on the account the node picks ([#84](https://github.com/KinjiKawaguchi/scrum-harness/issues/84)) ([b2a1957](https://github.com/KinjiKawaguchi/scrum-harness/commit/b2a19576e919946cab941d927869e2da9a5238a2)), closes [#81](https://github.com/KinjiKawaguchi/scrum-harness/issues/81)
* **members:** start a member with Codex ([#76](https://github.com/KinjiKawaguchi/scrum-harness/issues/76)) ([aa58b0b](https://github.com/KinjiKawaguchi/scrum-harness/commit/aa58b0b9caf2263e28f97accee4771ebe78fec69))
* **members:** start members from the launch section ([#73](https://github.com/KinjiKawaguchi/scrum-harness/issues/73)) ([30ccedc](https://github.com/KinjiKawaguchi/scrum-harness/commit/30ccedce279577ab1b8f01bd79ddccfa8d8e6a07))
* **members:** stop members from the launch section ([#74](https://github.com/KinjiKawaguchi/scrum-harness/issues/74)) ([e424747](https://github.com/KinjiKawaguchi/scrum-harness/commit/e4247479724b294855fd3983601703ff18e003e9))
* **members:** tell a Codex member to go on when it sits idle at its prompt ([#118](https://github.com/KinjiKawaguchi/scrum-harness/issues/118)) ([a8e04a8](https://github.com/KinjiKawaguchi/scrum-harness/commit/a8e04a85cbf33a45482cfa47002503ebbde1a6cf))
* **members:** watch a member's startup and start it again when it shows nothing ([#77](https://github.com/KinjiKawaguchi/scrum-harness/issues/77)) ([2ec554d](https://github.com/KinjiKawaguchi/scrum-harness/commit/2ec554d2c11f09f89ff363a1c36a660baaf2b0fe))
* **ports:** address items by the item and let a tracker leave out GitHub-only parts ([#57](https://github.com/KinjiKawaguchi/scrum-harness/issues/57)) ([5fc4385](https://github.com/KinjiKawaguchi/scrum-harness/commit/5fc4385dda54b565ef95575b99e24da4eaa4be6e))
* **runtime:** answer the optional activity op from a 24-hour log ([#61](https://github.com/KinjiKawaguchi/scrum-harness/issues/61)) ([8d8b01f](https://github.com/KinjiKawaguchi/scrum-harness/commit/8d8b01f15e353901c0b4411f46c3d7d20cea2f4d))
* **runtime:** report when work was done ([#75](https://github.com/KinjiKawaguchi/scrum-harness/issues/75)) ([dbebfab](https://github.com/KinjiKawaguchi/scrum-harness/commit/dbebfaba8dd4060fa92d68705dbf5f39d940c879))
* **runtime:** say the harness release in describe ([#147](https://github.com/KinjiKawaguchi/scrum-harness/issues/147)) ([b87054c](https://github.com/KinjiKawaguchi/scrum-harness/commit/b87054cb0cdc7c0ad6a98da89d043dee42046fde))
* **runtime:** the prioritize op, which writes a ticket's board Priority ([#157](https://github.com/KinjiKawaguchi/scrum-harness/issues/157)) ([260d44f](https://github.com/KinjiKawaguchi/scrum-harness/commit/260d44f37574ea372e4bb020b52d588bf532a591))
* **runtime:** the tickets op of agency-runtime/1, and the board Priority in the dispatch order ([#156](https://github.com/KinjiKawaguchi/scrum-harness/issues/156)) ([630014e](https://github.com/KinjiKawaguchi/scrum-harness/commit/630014e079eca66d26a81fe29151564d537582ee))
* **team:** record when each session changes state, for a member's busy and idle time ([#98](https://github.com/KinjiKawaguchi/scrum-harness/issues/98)) ([848f4c8](https://github.com/KinjiKawaguchi/scrum-harness/commit/848f4c89bc3cd27e9b302c17d3a3fa65f0b9743e)), closes [#95](https://github.com/KinjiKawaguchi/scrum-harness/issues/95)
* **team:** record which member's session opened each pull request ([#99](https://github.com/KinjiKawaguchi/scrum-harness/issues/99)) ([c0c0d3d](https://github.com/KinjiKawaguchi/scrum-harness/commit/c0c0d3d29ae38ffa8f6731f936a0693a52500222))
* **usage:** count the tokens of Codex members ([#78](https://github.com/KinjiKawaguchi/scrum-harness/issues/78)) ([3e51e72](https://github.com/KinjiKawaguchi/scrum-harness/commit/3e51e72e7f3570f125f6c17a74136a1378f0a702))


### Bug fixes

* **agency-runtime:** count a member's time from when recording began, and name every recorded pull request's repository ([#108](https://github.com/KinjiKawaguchi/scrum-harness/issues/108)) ([df43de0](https://github.com/KinjiKawaguchi/scrum-harness/commit/df43de0ec35c99d8bf0bb8c4f518b0cc2727456b))
* **agency-runtime:** keep one runtime server for a socket, by a lock ([#124](https://github.com/KinjiKawaguchi/scrum-harness/issues/124)) ([9e2bb2a](https://github.com/KinjiKawaguchi/scrum-harness/commit/9e2bb2a38da2506c77d93e4a5c0f292bfd482ef2)), closes [#123](https://github.com/KinjiKawaguchi/scrum-harness/issues/123)
* **board:** leave epics out of the In Progress limit, and say what was counted ([#134](https://github.com/KinjiKawaguchi/scrum-harness/issues/134)) ([f671a5b](https://github.com/KinjiKawaguchi/scrum-harness/commit/f671a5b2067272d84ff6e674d9dd717fd91e4873))
* **board:** remove shared board copies that no team writes any more ([#158](https://github.com/KinjiKawaguchi/scrum-harness/issues/158)) ([1e9d093](https://github.com/KinjiKawaguchi/scrum-harness/commit/1e9d093b3bd393b5bf7dbe681f4f651317e573c3))
* **github:** count a small GraphQL query as a quarter of a point, not one ([#159](https://github.com/KinjiKawaguchi/scrum-harness/issues/159)) ([6ebe6fe](https://github.com/KinjiKawaguchi/scrum-harness/commit/6ebe6fe5f9282dd4801980554da77f6174f890eb))
* **members:** find a stopped member's session, and word the exit by product ([#93](https://github.com/KinjiKawaguchi/scrum-harness/issues/93)) ([7b2f880](https://github.com/KinjiKawaguchi/scrum-harness/commit/7b2f880834d9d40ca08f5904f82086a6fa6b5d67)), closes [#81](https://github.com/KinjiKawaguchi/scrum-harness/issues/81)
* **members:** keep a member where it is when the node cannot read its source's usage ([#91](https://github.com/KinjiKawaguchi/scrum-harness/issues/91)) ([2093523](https://github.com/KinjiKawaguchi/scrum-harness/commit/2093523ecb08906c641bfec299b5439354704ed7)), closes [#81](https://github.com/KinjiKawaguchi/scrum-harness/issues/81)
* **members:** recognize the trust question when the window breaks its text ([#128](https://github.com/KinjiKawaguchi/scrum-harness/issues/128)) ([c3a3a00](https://github.com/KinjiKawaguchi/scrum-harness/commit/c3a3a00758c4dc99f2ba3ec76aba02a8812ecfa7)), closes [#127](https://github.com/KinjiKawaguchi/scrum-harness/issues/127)
* **requests:** count an older answer on a request addressed to the owner as the owner's ([#141](https://github.com/KinjiKawaguchi/scrum-harness/issues/141)) ([3387b83](https://github.com/KinjiKawaguchi/scrum-harness/commit/3387b83aa660f6b3833c4b31bab0d72bc17954e3)), closes [#140](https://github.com/KinjiKawaguchi/scrum-harness/issues/140)
* **requests:** decide who decided from byParticipant, never from the member id ([#133](https://github.com/KinjiKawaguchi/scrum-harness/issues/133)) ([11f9c4f](https://github.com/KinjiKawaguchi/scrum-harness/commit/11f9c4f2acffcee056eee564426e08ba784f0565)), closes [#132](https://github.com/KinjiKawaguchi/scrum-harness/issues/132)
* **team:** keep a participant's day times within the day ([#105](https://github.com/KinjiKawaguchi/scrum-harness/issues/105)) ([1f3e5f9](https://github.com/KinjiKawaguchi/scrum-harness/commit/1f3e5f95ac7790e698aaaa3baf69d73cadfa93bb)), closes [#104](https://github.com/KinjiKawaguchi/scrum-harness/issues/104)
* **team:** keep the name SCRUM_NAME gives a session, so a Codex member's tokens are attributed ([#110](https://github.com/KinjiKawaguchi/scrum-harness/issues/110)) ([99b18e6](https://github.com/KinjiKawaguchi/scrum-harness/commit/99b18e602d5632ebad9c86015cc587bf4b2a42ad)), closes [#109](https://github.com/KinjiKawaguchi/scrum-harness/issues/109)
* **team:** log a session's first state line, and keep a turn's end and the next prompt that come together ([#101](https://github.com/KinjiKawaguchi/scrum-harness/issues/101)) ([78bfab4](https://github.com/KinjiKawaguchi/scrum-harness/commit/78bfab47a08c18cf8412ae1beea2522c1642e19f)), closes [#100](https://github.com/KinjiKawaguchi/scrum-harness/issues/100)


### Performance

* **agency-runtime:** answer scrum runtime from a long-lived server ([#122](https://github.com/KinjiKawaguchi/scrum-harness/issues/122)) ([a38dc48](https://github.com/KinjiKawaguchi/scrum-harness/commit/a38dc489749dbf5986ce9a58423062aa26f7d85b)), closes [#120](https://github.com/KinjiKawaguchi/scrum-harness/issues/120)
* **agency-runtime:** decide on the item in the stored board copy, without reading the board again ([#121](https://github.com/KinjiKawaguchi/scrum-harness/issues/121)) ([16ac88b](https://github.com/KinjiKawaguchi/scrum-harness/commit/16ac88b09516b2f773733f2f89e066d2ca5bdd53)), closes [#120](https://github.com/KinjiKawaguchi/scrum-harness/issues/120)
* **hooks:** place a session that has SCRUM_NAME in the shell, without starting node ([#126](https://github.com/KinjiKawaguchi/scrum-harness/issues/126)) ([ec559d3](https://github.com/KinjiKawaguchi/scrum-harness/commit/ec559d3fd5237197c6d7e9a075491f5c457d9124)), closes [#125](https://github.com/KinjiKawaguchi/scrum-harness/issues/125)


### Documentation

* say what each rule needs from the board adapter ([#66](https://github.com/KinjiKawaguchi/scrum-harness/issues/66)) ([0154df9](https://github.com/KinjiKawaguchi/scrum-harness/commit/0154df97915dbc3245dff9132ba874ad0edefcee))

## 0.1.0 (2026-11-26)


### Features

* **ops:** make releases with release-please ([#58](https://github.com/KinjiKawaguchi/scrum-harness/issues/58)) ([6eaf495](https://github.com/KinjiKawaguchi/scrum-harness/commit/6eaf49560a30b2133db66d40550d3399fec1a096))
