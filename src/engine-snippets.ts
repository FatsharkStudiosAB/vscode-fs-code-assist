
/**
 * Lua helpers that get injected int the debuggee runtime.
 */
export const luaHelpers = [
    `
    if not to_console_string then
        function to_console_string(x)
            local function comp(a,b)
                if  type(a) ~= type(b) then
                    return type(a) < type(b)
                else
                    return a < b
                end
            end

            if type(x) == 'table' then
                return string.format('%s', x)
            elseif type(x) == 'function' then
                local info = debug.getinfo(x)
                if info.what == 'C' then
                    return 'C function'
                else
                    return 'Lua function, ' .. info.short_src .. ':' .. info.linedefined
                end
                return to_console_string(info)
            else
                return tostring(x)
            end
        end
    end
    `,
    `
    if not send_script_output then
        function send_script_output(result, requestId)
            local msg = {type = 'script_output'}
            msg.result = result
            msg.result_type = type(result)
            msg.requestId = requestId
            stingray.Application.console_send(msg);
        end
    end
    `,
    `
    if not evaluate_script_expression then
        function evaluate_script_expression(expression, requestId)
            local script = loadstring(expression)
            if script == nil then
                script = loadstring("return " .. expression)
            end
            if script then
                local result = script()
                send_script_output(result, requestId)
            end
        end
    end
    `
];