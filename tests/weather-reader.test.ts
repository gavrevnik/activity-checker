import {expect,it,vi} from 'vitest';
import {weatherRead} from '../server/weather-reader';
it('uses only fixed forecast endpoint and returns timezone/units with a cache',async()=>{
 const fetch=vi.fn(async(_url:string)=>new Response(JSON.stringify({latitude:44.81,longitude:20.46,timezone:'Europe/Belgrade',utc_offset_seconds:7200,current:{temperature_2m:18},current_units:{temperature_2m:'°C'},hourly:{time:[],temperature_2m:[]},hourly_units:{temperature_2m:'°C'},daily:{time:[]},daily_units:{}})));
 const first=await weatherRead({latitude:44.81761,forecastDays:2},fetch);expect(first.readOnly).toBe(true);expect(first.timezone).toBe('Europe/Belgrade');expect(first.current_units?.temperature_2m).toBe('°C');
 const url=new URL(fetch.mock.calls[0][0]);expect(url.origin+url.pathname).toBe('https://api.open-meteo.com/v1/forecast');expect(url.searchParams.get('forecast_days')).toBe('2');
 const cached=await weatherRead({latitude:44.81761,forecastDays:2},fetch);expect(cached.cached).toBe(true);expect(fetch).toHaveBeenCalledOnce();
 await expect(weatherRead({forecastDays:17},fetch)).rejects.toThrow();await expect(weatherRead({timeZone:'unknown'},fetch)).rejects.toThrow();
});
