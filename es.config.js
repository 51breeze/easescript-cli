module.exports = {
    workspace:'test/src',
    types:['test/index.d.es'],
    plugins:[
        {
            name:'es-javascript',
            plugin:require('../es-javascript'),
            options:{
                useAbsolutePathImport:true,
                sourceMaps:true
            }
        },
        // {
        //     name:'es-php',
        //     plugin:require('../es-php'),
        //     options:{
        //         bundle:{
        //             enable:true,
        //             plugins:[
        //                 {
        //                     name:'es-javascript',
        //                     plugin:require('../es-javascript'),
        //                     options:{
        //                         useAbsolutePathImport:true,
        //                         sourceMaps:true
        //                     }
        //                 },
        //             ]
        //         }
        //     }
        // }
    ]
}