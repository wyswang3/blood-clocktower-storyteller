'use strict';

/**
 * 角色静态数据。只放牌面信息，不放任何对局状态。
 * 能力文案是官方卡面的中文转述，玩家靠它知道该干什么。
 */

const TYPE = Object.freeze({
  TOWNSFOLK: 'townsfolk',
  OUTSIDER: 'outsider',
  MINION: 'minion',
  DEMON: 'demon',
});

const TYPE_LABEL = Object.freeze({
  townsfolk: '镇民',
  outsider: '外来者',
  minion: '爪牙',
  demon: '恶魔',
});

const TEAM_LABEL = Object.freeze({ good: '好人', evil: '坏人' });

const ROLES = {
  /* ---------------- 镇民 ---------------- */
  washerwoman: {
    id: 'washerwoman', name: '洗衣妇', en: 'Washerwoman', type: TYPE.TOWNSFOLK,
    brief: '第一夜，你会得知两名玩家中有一人是某个镇民。',
  },
  librarian: {
    id: 'librarian', name: '图书管理员', en: 'Librarian', type: TYPE.TOWNSFOLK,
    brief: '第一夜，你会得知两名玩家中有一人是某个外来者；若本局没有外来者，你会得知这一点。',
  },
  investigator: {
    id: 'investigator', name: '调查员', en: 'Investigator', type: TYPE.TOWNSFOLK,
    brief: '第一夜，你会得知两名玩家中有一人是某个爪牙。',
  },
  chef: {
    id: 'chef', name: '厨师', en: 'Chef', type: TYPE.TOWNSFOLK,
    brief: '第一夜，你会得知有多少对邪恶玩家相邻（坐在相邻座位）。',
  },
  empath: {
    id: 'empath', name: '共情者', en: 'Empath', type: TYPE.TOWNSFOLK,
    brief: '每夜，你会得知你两侧最近的存活邻居中有几人是邪恶的。',
  },
  fortune_teller: {
    id: 'fortune_teller', name: '占卜师', en: 'Fortune Teller', type: TYPE.TOWNSFOLK,
    brief: '每夜，选择两名玩家：你会得知其中是否有恶魔。有一名好人会被当作恶魔（红鲱鱼）。',
  },
  undertaker: {
    id: 'undertaker', name: '掘墓人', en: 'Undertaker', type: TYPE.TOWNSFOLK,
    brief: '每夜（第一夜除外），你会得知昨天因处决而死亡的玩家的角色。',
  },
  monk: {
    id: 'monk', name: '僧侣', en: 'Monk', type: TYPE.TOWNSFOLK,
    brief: '每夜（第一夜除外），选择一名除自己以外的玩家：他今晚不会被恶魔杀害。',
  },
  ravenkeeper: {
    id: 'ravenkeeper', name: '守鸦人', en: 'Ravenkeeper', type: TYPE.TOWNSFOLK,
    brief: '如果你在夜晚死亡，你会被唤醒，选择一名玩家并得知他的角色。',
  },
  virgin: {
    id: 'virgin', name: '贞洁烈女', en: 'Virgin', type: TYPE.TOWNSFOLK,
    brief: '你第一次被提名时，如果提名你的人是镇民，他立即被处决。',
  },
  slayer: {
    id: 'slayer', name: '杀手', en: 'Slayer', type: TYPE.TOWNSFOLK,
    brief: '一局一次，白天公开选择一名玩家：如果他是恶魔，他死亡。',
  },
  soldier: {
    id: 'soldier', name: '士兵', en: 'Soldier', type: TYPE.TOWNSFOLK,
    brief: '你不会受到恶魔能力的伤害。',
  },
  mayor: {
    id: 'mayor', name: '镇长', en: 'Mayor', type: TYPE.TOWNSFOLK,
    brief: '一天结束时，如果恰有 3 名玩家存活且当天没有处决，好人获胜。你若将在夜间死亡，可能由另一名玩家代替死亡。',
  },

  /* ---------------- 外来者 ---------------- */
  butler: {
    id: 'butler', name: '管家', en: 'Butler', type: TYPE.OUTSIDER,
    brief: '每夜，选择一名玩家（不能是自己）作为主人。第二天，只有主人投票时你才能投票。',
  },
  drunk: {
    id: 'drunk', name: '酒鬼', en: 'Drunk', type: TYPE.OUTSIDER,
    brief: '你以为自己是某个镇民，但你的能力并不生效。',
  },
  recluse: {
    id: 'recluse', name: '隐士', en: 'Recluse', type: TYPE.OUTSIDER,
    brief: '你可能被当作邪恶、爪牙或恶魔，即使你已经死亡。',
  },
  saint: {
    id: 'saint', name: '圣徒', en: 'Saint', type: TYPE.OUTSIDER,
    brief: '如果你因处决而死亡，你的阵营落败。',
  },

  /* ---------------- 爪牙 ---------------- */
  poisoner: {
    id: 'poisoner', name: '投毒者', en: 'Poisoner', type: TYPE.MINION,
    brief: '每夜，选择一名玩家：他中毒，直到下一次黄昏。',
  },
  spy: {
    id: 'spy', name: '间谍', en: 'Spy', type: TYPE.MINION,
    brief: '每夜，你查看魔典。你可能被当作善良、镇民或外来者，即使你已经死亡。',
  },
  scarlet_woman: {
    id: 'scarlet_woman', name: '红唇女郎', en: 'Scarlet Woman', type: TYPE.MINION,
    brief: '如果恶魔死亡前至少有 5 名玩家存活，你成为该恶魔（不计旅行者）。',
  },
  baron: {
    id: 'baron', name: '男爵', en: 'Baron', type: TYPE.MINION,
    brief: '设置时，用两名外来者替换两名镇民。[+2 外来者]',
  },

  /* ---------------- 恶魔 ---------------- */
  imp: {
    id: 'imp', name: '小恶魔', en: 'Imp', type: TYPE.DEMON,
    brief: '每夜（第一夜除外），选择一名玩家：他死亡。如果你以此法杀死自己，一名爪牙成为小恶魔。',
  },
};

const ALL_IDS = Object.keys(ROLES);

function getRole(id) {
  const r = ROLES[id];
  if (!r) throw new Error('未知角色: ' + id);
  return r;
}

function typeOf(id) {
  return getRole(id).type;
}

function teamOf(id) {
  const t = typeOf(id);
  return t === TYPE.MINION || t === TYPE.DEMON ? 'evil' : 'good';
}

function isEvilType(t) {
  return t === TYPE.MINION || t === TYPE.DEMON;
}

function idsByType(type) {
  return ALL_IDS.filter((id) => ROLES[id].type === type);
}

/** 给前端用的精简角色对象（不含任何对局信息）。 */
function roleCard(id) {
  const r = getRole(id);
  return {
    id: r.id,
    name: r.name,
    en: r.en,
    type: r.type,
    typeLabel: TYPE_LABEL[r.type],
    team: teamOf(id),
    brief: r.brief,
  };
}

module.exports = {
  TYPE,
  TYPE_LABEL,
  TEAM_LABEL,
  ROLES,
  ALL_IDS,
  getRole,
  typeOf,
  teamOf,
  isEvilType,
  idsByType,
  roleCard,
};
