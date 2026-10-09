import {z} from 'zod';
import {publicFetch} from './public-fetch.js';
export const weatherInput=z.object({latitude:z.number().min(-90).max(90).default(44.8176),longitude:z.number().min(-180).max(180).default(20.4633),forecastDays:z.number().int().min(1).max(16).default(7),timeZone:z.string().min(1).max(80).default('Europe/Belgrade')}).strict();
const forecastSchema=z.object({latitude:z.number(),longitude:z.number(),timezone:z.string(),utc_offset_seconds:z.number(),current:z.record(z.string(),z.unknown()).optional(),current_units:z.record(z.string(),z.unknown()).optional(),hourly:z.record(z.string(),z.unknown()),hourly_units:z.record(z.string(),z.unknown()),daily:z.record(z.string(),z.unknown()),daily_units:z.record(z.string(),z.unknown())});
type WeatherResult=z.output<typeof forecastSchema>&{provider:string;sourceUrl:string;requestedCoordinates:{latitude:number;longitude:number};fetchedAt:string;cached:boolean;readOnly:boolean;attribution:string;limitations:string};
const host=new Set(['api.open-meteo.com']);
const cache=new Map<string,{at:number;data:WeatherResult}>();
type Fetcher=(url:string)=>Promise<Response>;
export async function weatherRead(input:z.input<typeof weatherInput>,fetcher:Fetcher=(url)=>publicFetch(url,{}, {hosts:host,maxBytes:512*1024})) {
 const args=weatherInput.parse(input);
 try{new Intl.DateTimeFormat('en',{timeZone:args.timeZone}).format();}catch{throw new Error('Invalid IANA timeZone');}
 const url=new URL('https://api.open-meteo.com/v1/forecast');url.search=new URLSearchParams({latitude:String(args.latitude),longitude:String(args.longitude),timezone:args.timeZone,forecast_days:String(args.forecastDays),current:'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',hourly:'temperature_2m,precipitation_probability,precipitation,wind_speed_10m',daily:'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset'}).toString();
 const hit=cache.get(url.href);if(hit&&Date.now()-hit.at<10*60*1000)return {...hit.data,cached:true};
 const response=await fetcher(url.href);if(!response.ok)throw new Error(`Open-Meteo HTTP ${response.status}; no paid fallback`);
 const data=forecastSchema.parse(await response.json());
 const result={provider:'Open-Meteo',sourceUrl:url.href,requestedCoordinates:{latitude:args.latitude,longitude:args.longitude},fetchedAt:new Date().toISOString(),...data,cached:false,readOnly:true,attribution:'Weather data by Open-Meteo.com (CC BY 4.0)',limitations:'Model forecast, not a guarantee. Free personal/non-commercial endpoint; no API key or paid fallback.'};
 if(cache.size>=100)cache.delete(cache.keys().next().value!);cache.set(url.href,{at:Date.now(),data:result});return result;
}
