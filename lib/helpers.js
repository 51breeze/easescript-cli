const chalk = require('chalk');
const clients = ['es-nuxt','es-vue','es-javascript'];
const servers = ['es-php','es-thinkphp','es-node'];
function isClientSide(plugin){
    let options = plugin.options || {};
    if(options.platform ==="client" || options.metadata?.platform === 'client'){
        return true;
    }
    return clients.some(client => plugin.name.includes(client));
}

function isServerSide(plugin){
    let options = plugin.options || {};
    if(options.platform ==="server" || options.metadata?.platform === 'server'){
        return true;
    }
    return servers.some(server => plugin.name.includes(server));
}

function getPlugins(config={}){
    const load = ()=>{
        if(config.plugin && typeof config.plugin==='function'){
            return config.plugin;
        }else if(config.name){
            return require(config.name)
        }else{
            throw new Error('Plugin name invalid')
        }
    }
    let plugin = load();
    if(typeof plugin ==='object' && plugin.default){
        plugin = plugin.default;
    }
    return plugin(config.options)
}

async function callAsyncSequence(items, asyncMethod){
    if(!Array.isArray(items))return false;
    if(items.length<1)return false;
    let index = 0;
    items = items.slice(0);
    const callAsync = async()=>{
        if(index<items.length){
            await asyncMethod(items[index], index++)
            await callAsync();
        }
    }
    await callAsync();
}

function formatMessage(outdir){
    let message = [
        'Build successful!',
        `Output:${outdir}`
    ];

    let strLen = 0;
    let hideMaxLen = 0;
    let hideChars = ['\x1B[31m','\x1B[39m'];
    message.forEach( item=>{
        let len = 0;
        hideChars.forEach( match=>{
            if( item.includes(match) ){
                len+=match.length;
            }
        });
        if(len>0){
            hideMaxLen = Math.max(len, hideMaxLen);
        }
        strLen = Math.max(strLen, item.length);
    });

    let sep =  '*'.repeat(strLen-hideMaxLen+10);
    let format = ()=>{
        let padding = '   ';
        return message.map( item=>{
            item = item.padEnd(strLen-(padding.length*2)-4);
            item = padding+item+padding;
            item = sep.slice(0,2) +item + sep.slice(-2);
            return item;
        }).join('\n');
    }
    console.info(chalk.green(`${sep}\n${format()}\n${sep}`))
}


module.exports = {
    isClientSide,
    isServerSide,
    getPlugins,
    callAsyncSequence,
    formatMessage
};