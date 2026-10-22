import { localDate } from './store.js';

export function resolveDateFilters(question,filters={},now=new Date()) {
  const result={...filters};
  for(const key of ['from','to']) if(result[key] && !/^\d{4}-\d{2}-\d{2}$/.test(result[key])) throw new Error('日期格式应为 YYYY-MM-DD');
  if(result.from || result.to) {if(result.from && result.to && result.from>result.to)throw new Error('起始日期不能晚于结束日期');return result;}
  const today=localDate(now),[year,month,day]=today.split('-').map(Number);
  const format=(y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  if(/最近(?:一个月|一月|30天|三十天)|近一个月/.test(question)) {
    result.to=today;result.from=localDate(new Date(now.getTime()-30*86400000));return result;
  }
  if(/上个月|上月/.test(question)){const m=month===1?12:month-1,y=month===1?year-1:year;result.from=format(y,m,1);result.to=format(y,m,new Date(Date.UTC(y,m,0)).getUTCDate());return result;}
  if(/这个月|本月/.test(question)){result.from=format(year,month,1);result.to=format(year,month,day);return result;}
  const match=question.match(/(?:(20\d{2})年\s*)?(十一|十二|十|[一二三四五六七八九]|1[0-2]|0?[1-9])月/);
  if(match){const names=['','一','二','三','四','五','六','七','八','九','十','十一','十二'];const m=Number(match[2])||names.indexOf(match[2]);const y=match[1]?Number(match[1]):(/去年/.test(question)?year-1:/今年/.test(question)?year:m>month?year-1:year);result.from=format(y,m,1);result.to=format(y,m,new Date(Date.UTC(y,m,0)).getUTCDate());}
  return result;
}
